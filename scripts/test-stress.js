// Stress tests for the situations most likely to break. Run: npm run test:stress
// Each step is reported on its own; one failure does not stop the rest.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Store } = require('../src/store');
const { Net } = require('../src/net');
const dgram = require('dgram');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { deriveKeys, seal, encryptStream, decryptStream } = require('../src/crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MB = 1024 * 1024;

async function until(fn, label, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(40);
  }
  throw new Error(`timed out: ${label}`);
}

function device(root, name, code) {
  const store = new Store(path.join(root, name));
  store.set({ deviceName: name, ...(code ? { code } : {}) });
  return { name, store, net: new Net(store) };
}

async function restart(d) {
  d.net = new Net(d.store);
  await d.net.start();
}

const ids = (d) => d.store.state.items.map((i) => i.id).join(',');
const connected = (...ds) => ds.every((d) => d.net.peers.size >= ds.length - 1);

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => hash.update(c)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
}

async function makeFile(file, megabytes) {
  const out = fs.createWriteStream(file);
  const block = crypto.randomBytes(MB);
  for (let i = 0; i < megabytes; i++) {
    block.writeUInt32LE(i, 0); // make every block different
    if (!out.write(block)) await new Promise((r) => out.once('drain', r));
  }
  await new Promise((r) => out.end(r));
  return hashFile(file);
}

const leftovers = (d) => fs.readdirSync(d.store.filesDir);

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synctray-stress-'));
  const a = device(root, 'Mac');
  const b = device(root, 'Windows', a.store.state.code);
  const results = [];

  async function step(name, fn) {
    const started = Date.now();
    try {
      const note = await fn();
      results.push(true);
      console.log(`✓ ${name}${note ? ` (${note})` : ''} [${Date.now() - started} ms]`);
    } catch (err) {
      results.push(false);
      console.log(`✗ ${name}\n    → ${err.message}`);
    }
  }

  async function reset() {
    for (const d of [a, b]) {
      const ts = Date.now();
      d.net.publishDelete(d.store.clear(ts), ts);
    }
    await until(() => !a.store.state.items.length && !b.store.state.items.length, 'reset');
    await sleep(200);
  }

  try {
    await a.net.start();
    await b.net.start();
    await until(() => connected(a, b), 'first connection');

    await step('300 texts sent in a burst leave both lists identical', async () => {
      for (let i = 0; i < 300; i++) a.net.publish(await a.store.addText(`line ${i}`));
      await until(() => ids(a) === ids(b), 'lists did not converge', 20000);
      assert.strictEqual(a.store.state.items[0].text, 'line 299', 'newest item must be on top');
      return `${a.store.state.items.length} items kept`;
    });

    await reset();
    await step('both devices sending 100 texts at once leave both lists identical', async () => {
      await Promise.all(
        [a, b].map(async (d) => {
          for (let i = 0; i < 100; i++) {
            d.net.publish(await d.store.addText(`${d.name} ${i}`));
            if (i % 10 === 0) await sleep(1);
          }
        })
      );
      await until(() => ids(a) === ids(b), 'lists did not converge', 45000);
    });

    await reset();
    await step('a huge 5 MB text reaches the other device', async () => {
      const big = 'x'.repeat(5 * MB);
      const item = await a.store.addText(big);
      a.net.publish(item);
      await until(() => b.store.get(item.id) && (item.type === 'text' || b.store.hasFile(item.id)), 'huge text did not arrive', 12000);
      return item.type === 'file' ? `converted to a file: ${item.name}` : 'as text';
    });

    await reset();
    await step('items sent while the other device is off arrive when it starts', async () => {
      b.net.stop();
      await sleep(300);
      for (let i = 0; i < 5; i++) a.net.publish(await a.store.addText(`offline ${i}`));
      const src = path.join(root, 'small.bin');
      const hash = await makeFile(src, 3);
      const file = await a.store.addFile(src);
      a.net.publish(file);
      await restart(b);
      await until(() => ids(a) === ids(b) && b.store.hasFile(file.id), 'did not sync after start', 15000);
      assert.strictEqual(await hashFile(b.store.filePath(file.id)), hash);
    });

    await step('a captured header cannot be used to inject content', async () => {
      const url = (p) => `http://127.0.0.1:${b.net.port}${p}`;
      const fake = { id: crypto.randomUUID(), type: 'text', text: 'FORGED', from: { id: 'x', name: 'Attacker' }, ts: Date.now() };
      const payload = JSON.stringify({ items: [fake] });
      const post = (p, header, body) => fetch(url(p), { method: 'POST', headers: { 'x-seal': header }, body });

      // 1) valid header + plaintext body
      const h1 = a.net.sealHeader('POST', '/items');
      assert.strictEqual((await post('/items', h1.header, payload)).status, 401);
      // 2) valid header + a body sealed (with the right key) for another request
      const h2 = a.net.sealHeader('POST', '/items');
      const otherBody = seal(a.net.keys().enc, payload, `body ${h1.nonce}`);
      assert.strictEqual((await post('/items', h2.header, otherBody)).status, 401);
      // 3) a header issued for another path used on a delete request
      const h3 = a.net.sealHeader('GET', '/index');
      assert.strictEqual((await post('/delete', h3.header, payload)).status, 401);
      // 4) a request sealed with the wrong code
      const wrong = deriveKeys('WRONGCODE123');
      const box = seal(wrong.enc, JSON.stringify({ ts: Date.now(), id: 'x', name: 'x', port: 1 }), 'req POST /items');
      assert.strictEqual((await post('/items', box.toString('base64'), seal(wrong.enc, payload, 'body x'))).status, 401);

      assert.ok(!b.store.get(fake.id), 'forged item was accepted');
    });

    await reset();
    await step('nothing on the wire is readable (text, files, device name)', async () => {
      const SECRET = 'TOP-SECRET-PASSWORD-918273';
      const text = await a.store.addText(`my password: ${SECRET}`);
      const file = await a.store.addBuffer('secret.txt', Buffer.from(`${SECRET}\n`.repeat(5000)));
      a.net.publish(text);
      a.net.publish(file);
      await until(() => b.store.hasFile(file.id), 'items did not arrive');

      // The raw bytes an eavesdropper would see: bodies of requests from b to a, and the responses
      const captured = [];
      const raw = async (method, p, data) => {
        const { header, nonce } = b.net.sealHeader(method, p);
        const body = data ? seal(b.net.keys().enc, JSON.stringify(data), `body ${nonce}`) : undefined;
        if (body) captured.push(body);
        captured.push(Buffer.from(header));
        const res = await fetch(`http://127.0.0.1:${a.net.port}${p}`, { method, headers: { 'x-seal': header }, body });
        assert.strictEqual(res.status, 200, `${p} → ${res.status}`);
        captured.push(Buffer.from(await res.arrayBuffer()));
      };
      await raw('GET', '/index');
      await raw('POST', '/get', { ids: [text.id, file.id] });
      await raw('GET', `/files/${file.id}`);
      await raw('POST', '/items', { items: [text] });

      // Broadcast packet
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      const packet = new Promise((resolve) => sock.once('message', resolve));
      await new Promise((r) => sock.bind(47801, r));
      a.net.beacon();
      captured.push(await Promise.race([packet, sleep(4000).then(() => Buffer.alloc(0))]));
      sock.close();

      const wire = Buffer.concat(captured).toString('latin1');
      assert.ok(wire.length > 100000, 'captured less data than expected');
      for (const needle of [SECRET, 'my password', 'secret.txt', a.store.state.deviceName, a.store.state.deviceId, text.id]) {
        assert.ok(!wire.includes(needle), `visible in clear on the wire: ${needle}`);
      }
      return `${Math.round(wire.length / 1024)} KB of raw data scanned`;
    });

    await step('encrypted file stream: tampering, truncation and a wrong key are detected', async () => {
      const key = deriveKeys('TESTKODU1234').enc;
      const plain = crypto.randomBytes(200 * 1024 + 123);
      const collect = async (source, ...transforms) => {
        const out = [];
        const sink = new (require('stream').Writable)({ write: (c, _e, cb) => (out.push(c), cb()) });
        await pipeline(Readable.from(source), ...transforms, sink);
        return Buffer.concat(out);
      };
      const sealed = await collect([plain.subarray(0, 70000), plain.subarray(70000)], encryptStream(key, 'file t'));
      const piecemeal = function* (buf, n) { for (let i = 0; i < buf.length; i += n) yield buf.subarray(i, i + n); };

      assert.ok((await collect(piecemeal(sealed, 1000), decryptStream(key, 'file t'))).equals(plain), 'decrypted data differs');
      const empty = await collect([], encryptStream(key, 'file e'));
      assert.strictEqual((await collect([empty], decryptStream(key, 'file e'))).length, 0, 'empty file');

      const fails = async (label, data, k = key, aad = 'file t') => {
        await assert.rejects(collect([data], decryptStream(k, aad)), undefined, `${label} went undetected`);
      };
      const flipped = Buffer.from(sealed);
      flipped[100000] ^= 1;
      await fails('single flipped bit', flipped);
      await fails('truncated end', sealed.subarray(0, sealed.length - 70000));
      await fails('truncation exactly on a chunk boundary', sealed.subarray(0, 16 + 5 + 65536 + 16));
      await fails('wrong key', sealed, deriveKeys('OTHERCODE999').enc);
      await fails('stream from another request', sealed, key, 'file other');
    });

    await step('dangerous file names and expired items are filtered', async () => {
      const mk = (extra) => ({ id: crypto.randomUUID(), type: 'file', size: 1, from: { id: 'x', name: 'y' }, ts: Date.now(), ...extra });
      const evil = mk({ name: '..\\..\\Windows\\evil.exe' });
      const evil2 = mk({ name: '../../.ssh/authorized_keys' });
      b.store.addRemote(evil);
      b.store.addRemote(evil2);
      assert.strictEqual(b.store.get(evil.id).name, 'evil.exe');
      assert.strictEqual(b.store.get(evil2.id).name, 'authorized_keys');
      const old = mk({ name: 'old.txt', ts: Date.now() - 30 * 24 * 3600 * 1000 });
      assert.strictEqual(b.store.addRemote(old), false, 'expired item was accepted');
      b.store.remove(evil.id);
      b.store.remove(evil2.id);
    });

    await reset();
    const bigSrc = path.join(root, 'big.bin');
    const bigHash = await makeFile(bigSrc, 300);

    await step('a 300 MB file arrives intact, with progress reported on both sides', async () => {
      const seen = { in: 0, out: 0 };
      const watch = (d) => () => {
        for (const t of Object.values(d.net.transferState())) seen[t.dir] = Math.max(seen[t.dir], t.done / t.total);
      };
      const wa = watch(a);
      const wb = watch(b);
      a.net.on('progress', wa);
      b.net.on('progress', wb);
      const file = await a.store.addFile(bigSrc);
      a.net.publish(file);
      await until(() => b.store.hasFile(file.id), 'file did not arrive', 60000);
      a.net.off('progress', wa);
      b.net.off('progress', wb);
      assert.strictEqual(await hashFile(b.store.filePath(file.id)), bigHash, 'contents differ');
      assert.ok(seen.in > 0, 'no progress reported on the receiver');
      assert.ok(seen.out > 0, 'no progress reported on the sender');
      await until(() => !Object.keys(a.net.transferState()).length && !Object.keys(b.net.transferState()).length, 'transfer record was not cleared', 3000);
    });

    await reset();
    await step('receiver restarting mid-transfer still ends with the complete file', async () => {
      b.net.once('progress', () => b.net.stop());
      const file = await a.store.addFile(bigSrc);
      a.net.publish(file);
      await sleep(1500);
      assert.ok(!b.store.hasFile(file.id), 'partial file was treated as complete');
      await restart(b);
      await until(() => b.store.hasFile(file.id), 'did not complete after restart', 60000);
      assert.strictEqual(await hashFile(b.store.filePath(file.id)), bigHash, 'contents differ');
      assert.deepStrictEqual(leftovers(b), [file.id], 'partial file left behind');
    });

    await reset();
    await step('sender restarting mid-transfer still ends with the complete file', async () => {
      b.net.once('progress', () => a.net.stop());
      const file = await a.store.addFile(bigSrc);
      a.net.publish(file);
      await sleep(1500);
      assert.ok(!b.store.hasFile(file.id), 'partial file was treated as complete');
      await until(() => !Object.keys(b.net.transferState()).length, 'transfer left hanging on the receiver', 5000);
      await restart(a);
      await until(() => b.store.hasFile(file.id), 'did not complete after the sender returned', 60000);
      assert.strictEqual(await hashFile(b.store.filePath(file.id)), bigHash, 'contents differ');
    });

    await reset();
    await step('a sender that silently freezes (sleep) does not leave the transfer hanging', async () => {
      // A fake device that sends headers and a few bytes, then goes silent
      const frozen = http.createServer((req, res) => {
        res.writeHead(200);
        res.write(Buffer.alloc(10));
      });
      await new Promise((r) => frozen.listen(0, r));
      const item = { id: crypto.randomUUID(), type: 'file', name: 'frozen.bin', size: 50 * MB, from: { id: 'f', name: 'Frozen' }, ts: Date.now() };
      b.store.addRemote(item);
      b.net.stallMs = 1500;
      b.net.fetchFile({ id: 'f', host: '127.0.0.1', port: frozen.address().port }, b.store.get(item.id));
      await sleep(300);
      assert.ok(Object.keys(b.net.transferState()).length, 'transfer did not start');
      await until(() => !Object.keys(b.net.transferState()).length, 'frozen transfer was not abandoned', 6000);
      assert.ok(!leftovers(b).some((f) => f.startsWith(item.id)), 'partial file left behind');
      frozen.closeAllConnections();
      frozen.close();
      b.store.remove(item.id);
    });

    await reset();
    await step('"clear all" during a transfer leaves nothing behind', async () => {
      b.net.once('progress', () => {
        const ts = Date.now();
        a.net.publishDelete(a.store.clear(ts), ts);
      });
      const file = await a.store.addFile(bigSrc);
      a.net.publish(file);
      await until(() => !a.store.state.items.length && !b.store.state.items.length, 'not cleared', 10000);
      await until(() => !leftovers(a).length && !leftovers(b).length, `files left behind: A=${leftovers(a)} B=${leftovers(b)}`, 10000);
    });
  } catch (err) {
    results.push(false);
    console.error('\n✗ UNEXPECTED ERROR:', err.message);
  } finally {
    a.net.stop();
    b.net.stop();
    await sleep(200);
    fs.rmSync(root, { recursive: true, force: true });
  }

  const failed = results.filter((ok) => !ok).length;
  console.log(failed ? `\n${failed} step(s) failed.` : '\nAll stress tests passed.');
  process.exitCode = failed ? 1 : 0;
})();
