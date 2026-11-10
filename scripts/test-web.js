// Tests the phone/tablet web access against a real server, using the same wire code the
// browser runs (src/web/wire.mjs + @noble/ciphers). Run: npm run test:web
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Store } = require('../src/store');
const { Net } = require('../src/net');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, label, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(40);
  }
  throw new Error(`timed out: ${label}`);
}

(async () => {
  const { gcm } = await import('@noble/ciphers/aes.js');
  const { makeWire } = await import('../src/web/wire.mjs');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synctray-web-'));
  const mk = (name, code) => {
    const store = new Store(path.join(root, name));
    store.set({ deviceName: name, ...(code ? { code } : {}) });
    return { store, net: new Net(store) };
  };
  const a = mk('Mac');
  const b = mk('Windows', a.store.state.code);
  let failed = 0;

  async function step(name, fn) {
    try {
      const note = await fn();
      console.log(`✓ ${name}${note ? ` (${note})` : ''}`);
    } catch (err) {
      failed++;
      console.log(`✗ ${name}\n    → ${err.message}`);
    }
  }

  try {
    await a.net.start();
    await b.net.start();
    await until(() => a.net.peers.size === 1 && b.net.peers.size === 1, 'discovery');

    const base = `http://127.0.0.1:${a.net.port}`;
    const link = a.net.webLink();
    const key = Buffer.from(link.split('#')[1], 'base64url');
    const wire = makeWire(gcm, new Uint8Array(key));
    const me = { device: 'testphone', name: 'iPhone' };
    const raw = []; // everything that crossed the wire, for the plaintext scan

    const call = async (p, data = {}, w = wire) => {
      const { header, nonce } = w.header('POST', p, me);
      const body = w.seal(JSON.stringify(data), `body ${nonce}`);
      const res = await fetch(base + p, { method: 'POST', headers: { 'x-seal': header }, body });
      const bytes = new Uint8Array(await res.arrayBuffer());
      raw.push(Buffer.from(body), Buffer.from(header), Buffer.from(bytes));
      if (res.status === 401) return { status: 401 };
      return { status: res.status, ...JSON.parse(Buffer.from(w.open(bytes, `resp ${nonce}`)).toString()) };
    };

    await step('the page and its scripts are served, with no key inside', async () => {
      assert.ok(link.startsWith('http://') && link.includes('/m#'), `unexpected link: ${link}`);
      for (const p of ['/m', '/m/app.mjs', '/m/wire.mjs', '/m/app.css', '/m/vendor/aes.js', '/m/vendor/_polyval.js', '/m/vendor/utils.js']) {
        const res = await fetch(base + p);
        assert.strictEqual(res.status, 200, `${p} → ${res.status}`);
        const text = await res.text();
        assert.ok(text.length > 100, `${p} is empty`);
        assert.ok(!text.includes(link.split('#')[1]), `${p} contains the key`);
      }
      assert.strictEqual((await fetch(`${base}/m/../package.json`)).status, 401);
      assert.strictEqual((await fetch(`${base}/m/vendor/chacha.js`)).status, 401);
    });

    const SECRET = 'PHONE-SECRET-774411';
    let textId;
    await step('text sent from the phone reaches the computer and other devices', async () => {
      const res = await call('/w/text', { text: `note ${SECRET} çğıöşü` });
      assert.strictEqual(res.status, 200);
      textId = res.id;
      assert.strictEqual(a.store.get(textId).from.name, 'iPhone');
      await until(() => b.store.get(textId), 'text did not reach the second computer');
      assert.strictEqual(b.store.get(textId).text, `note ${SECRET} çğıöşü`);
    });

    await step('the phone sees the list, including items from computers', async () => {
      b.net.publish(await b.store.addText('from windows'));
      await until(() => a.store.state.items.length === 2, 'item from windows');
      const res = await call('/w/list');
      assert.strictEqual(res.device, 'Mac');
      assert.strictEqual(res.items.length, 2);
      assert.ok(res.items.some((i) => i.text === 'from windows'));
      assert.ok(res.items.some((i) => i.id === textId && i.from.id === res.me));
    });

    const payload = crypto.randomBytes(3 * 1024 * 1024 + 77);
    await step('a file downloads to the phone and decrypts to the identical bytes', async () => {
      const item = await a.store.addBuffer(`${SECRET}.bin`, payload);
      const p = `/w/file/${item.id}`;
      const { header, nonce } = wire.header('GET', p, me);
      const res = await fetch(base + p, { headers: { 'x-seal': header } });
      assert.strictEqual(res.status, 200);
      const sealed = new Uint8Array(await res.arrayBuffer());
      raw.push(Buffer.from(sealed));
      const plain = Buffer.concat(wire.decryptFile(sealed, `file ${nonce}`).map((c) => Buffer.from(c)));
      assert.ok(plain.equals(payload), 'downloaded bytes differ');

      const cut = sealed.subarray(0, sealed.length - 40000);
      assert.throws(() => wire.decryptFile(cut, `file ${nonce}`), undefined, 'truncation went undetected');
      const flipped = Uint8Array.from(sealed);
      flipped[70000] ^= 1;
      assert.throws(() => wire.decryptFile(flipped, `file ${nonce}`), undefined, 'tampering went undetected');
    });

    await step('a file uploaded from the phone arrives intact on both computers', async () => {
      const { header, nonce } = wire.header('POST', '/w/upload', { ...me, fileName: '../../evil photo.jpg' });
      const parts = wire.encryptFile(new Uint8Array(payload), `file ${nonce}`);
      const body = Buffer.concat(parts.map((p) => Buffer.from(p)));
      raw.push(body);
      const res = await fetch(`${base}/w/upload`, { method: 'POST', headers: { 'x-seal': header }, body });
      assert.strictEqual(res.status, 200);
      const { id } = JSON.parse(Buffer.from(wire.open(new Uint8Array(await res.arrayBuffer()), `resp ${nonce}`)).toString());
      assert.strictEqual(a.store.get(id).name, 'evil photo.jpg', 'file name was not sanitized');
      assert.ok(fs.readFileSync(a.store.filePath(id)).equals(payload), 'uploaded bytes differ');
      await until(() => b.store.hasFile(id), 'upload did not reach the second computer');
      assert.ok(fs.readFileSync(b.store.filePath(id)).equals(payload), 'bytes differ on the second computer');
    });

    await step('a corrupted upload is rejected and leaves nothing behind', async () => {
      const before = fs.readdirSync(a.store.filesDir).length;
      const { header, nonce } = wire.header('POST', '/w/upload', { ...me, fileName: 'bad.bin' });
      const body = Buffer.concat(wire.encryptFile(new Uint8Array(payload), `file ${nonce}`).map((p) => Buffer.from(p)));
      body[100000] ^= 1;
      const res = await fetch(`${base}/w/upload`, { method: 'POST', headers: { 'x-seal': header }, body });
      assert.strictEqual(res.status, 400);
      await until(() => fs.readdirSync(a.store.filesDir).length === before, 'partial upload left behind');
    });

    await step('delete from the phone propagates', async () => {
      assert.strictEqual((await call('/w/delete', { id: textId })).status, 200);
      assert.ok(!a.store.get(textId));
      await until(() => !b.store.get(textId), 'delete did not reach the second computer');
    });

    await step('wrong key, missing key and cross-use of keys are all rejected', async () => {
      const wrong = makeWire(gcm, new Uint8Array(crypto.randomBytes(32)));
      assert.strictEqual((await call('/w/list', {}, wrong)).status, 401);
      assert.strictEqual((await fetch(`${base}/w/list`, { method: 'POST' })).status, 401);
      // the web key must not open device-to-device routes, nor the device key the web routes
      const { header } = wire.header('GET', '/index', me);
      assert.strictEqual((await fetch(`${base}/index`, { headers: { 'x-seal': header } })).status, 401);
      const dev = a.net.sealHeader('POST', '/w/list');
      assert.strictEqual((await fetch(`${base}/w/list`, { method: 'POST', headers: { 'x-seal': dev.header } })).status, 401);
      // a header sealed for one path does not work on another
      const other = wire.header('POST', '/w/list', me);
      const res = await fetch(`${base}/w/delete`, { method: 'POST', headers: { 'x-seal': other.header }, body: wire.seal('{}', `body ${other.nonce}`) });
      assert.strictEqual(res.status, 401);
    });

    await step('changing the pairing code revokes the phone', async () => {
      a.store.set({ code: 'NEWCODE12345' });
      assert.strictEqual((await call('/w/list')).status, 401);
      assert.notStrictEqual(a.net.webLink(), link);
    });

    await step('nothing the phone sent or received is readable on the wire', async () => {
      const wireBytes = Buffer.concat(raw).toString('latin1');
      assert.ok(wireBytes.length > 6 * 1024 * 1024, 'captured less data than expected');
      for (const needle of [SECRET, 'from windows', 'iPhone', 'testphone', 'evil photo']) {
        assert.ok(!wireBytes.includes(needle), `visible in clear on the wire: ${needle}`);
      }
      return `${Math.round(wireBytes.length / 1024)} KB scanned`;
    });
  } catch (err) {
    failed++;
    console.error('\n✗ UNEXPECTED ERROR:', err.message);
  } finally {
    a.net.stop();
    b.net.stop();
    await sleep(200);
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(failed ? `\n${failed} step(s) failed.` : '\nAll web tests passed.');
  process.exitCode = failed ? 1 : 0;
})();
