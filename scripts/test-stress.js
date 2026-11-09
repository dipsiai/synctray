// Zorlama testleri: hata çıkarması muhtemel durumları dener. Çalıştır: npm run test:stress
// Her adım bağımsız raporlanır; biri başarısız olsa da diğerleri çalışır.
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
  throw new Error(`zaman aşımı: ${label}`);
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
    block.writeUInt32LE(i, 0); // bloklar birbirinden farklı olsun
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
    await until(() => !a.store.state.items.length && !b.store.state.items.length, 'sıfırlama');
    await sleep(200);
  }

  try {
    await a.net.start();
    await b.net.start();
    await until(() => connected(a, b), 'ilk bağlantı');

    await step('300 metin art arda gönderilince iki liste aynı oluyor', async () => {
      for (let i = 0; i < 300; i++) a.net.publish(await a.store.addText(`satır ${i}`));
      await until(() => ids(a) === ids(b), 'listeler eşitlenmedi', 20000);
      assert.strictEqual(a.store.state.items[0].text, 'satır 299', 'en yeni öğe en üstte olmalı');
      return `${a.store.state.items.length} öğe tutuldu`;
    });

    await reset();
    await step('iki cihaz aynı anda 100\'er metin gönderince listeler aynı oluyor', async () => {
      await Promise.all(
        [a, b].map(async (d) => {
          for (let i = 0; i < 100; i++) {
            d.net.publish(await d.store.addText(`${d.name} ${i}`));
            if (i % 10 === 0) await sleep(1);
          }
        })
      );
      await until(() => ids(a) === ids(b), 'listeler eşitlenmedi', 45000);
    });

    await reset();
    await step('5 MB\'lık dev metin karşıya ulaşıyor', async () => {
      const big = 'x'.repeat(5 * MB);
      const item = await a.store.addText(big);
      a.net.publish(item);
      await until(() => b.store.get(item.id) && (item.type === 'text' || b.store.hasFile(item.id)), 'dev metin gelmedi', 12000);
      return item.type === 'file' ? `dosyaya çevrildi: ${item.name}` : 'metin olarak';
    });

    await reset();
    await step('karşı cihaz kapalıyken gönderilenler açılınca geliyor', async () => {
      b.net.stop();
      await sleep(300);
      for (let i = 0; i < 5; i++) a.net.publish(await a.store.addText(`çevrimdışı ${i}`));
      const src = path.join(root, 'kucuk.bin');
      const hash = await makeFile(src, 3);
      const file = await a.store.addFile(src);
      a.net.publish(file);
      await restart(b);
      await until(() => ids(a) === ids(b) && b.store.hasFile(file.id), 'açılınca eşitlenmedi', 15000);
      assert.strictEqual(await hashFile(b.store.filePath(file.id)), hash);
    });

    await step('ağdan yakalanan başlıkla sahte içerik eklenemiyor', async () => {
      const url = (p) => `http://127.0.0.1:${b.net.port}${p}`;
      const fake = { id: crypto.randomUUID(), type: 'text', text: 'SAHTE', from: { id: 'x', name: 'Saldırgan' }, ts: Date.now() };
      const payload = JSON.stringify({ items: [fake] });
      const post = (p, header, body) => fetch(url(p), { method: 'POST', headers: { 'x-seal': header }, body });

      // 1) geçerli başlık + düz metin gövde
      const h1 = a.net.sealHeader('POST', '/items');
      assert.strictEqual((await post('/items', h1.header, payload)).status, 401);
      // 2) geçerli başlık + başka bir isteğe ait (geçerli anahtarla mühürlü) gövde
      const h2 = a.net.sealHeader('POST', '/items');
      const otherBody = seal(a.net.keys().enc, payload, `body ${h1.nonce}`);
      assert.strictEqual((await post('/items', h2.header, otherBody)).status, 401);
      // 3) başka yol için alınmış başlığı silme isteğinde kullanma
      const h3 = a.net.sealHeader('GET', '/index');
      assert.strictEqual((await post('/delete', h3.header, payload)).status, 401);
      // 4) yanlış kodla mühürlenmiş istek
      const wrong = deriveKeys('YANLISKOD123');
      const box = seal(wrong.enc, JSON.stringify({ ts: Date.now(), id: 'x', name: 'x', port: 1 }), 'req POST /items');
      assert.strictEqual((await post('/items', box.toString('base64'), seal(wrong.enc, payload, 'body x'))).status, 401);

      assert.ok(!b.store.get(fake.id), 'sahte öğe listeye girdi');
    });

    await reset();
    await step('ağdan geçen hiçbir şey okunamıyor (metin, dosya, cihaz adı)', async () => {
      const SECRET = 'COK-GIZLI-PAROLA-918273';
      const text = await a.store.addText(`parolam: ${SECRET}`);
      const file = await a.store.addBuffer('gizli.txt', Buffer.from(`${SECRET}\n`.repeat(5000)));
      a.net.publish(text);
      a.net.publish(file);
      await until(() => b.store.hasFile(file.id), 'öğeler gelmedi');

      // Ağı dinleyen birinin göreceği ham baytlar: b'nin a'ya attığı isteklerin gövdesi ve yanıtları
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

      // Yayın paketi
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      const packet = new Promise((resolve) => sock.once('message', resolve));
      await new Promise((r) => sock.bind(47801, r));
      a.net.beacon();
      captured.push(await Promise.race([packet, sleep(4000).then(() => Buffer.alloc(0))]));
      sock.close();

      const wire = Buffer.concat(captured).toString('latin1');
      assert.ok(wire.length > 100000, 'yakalanan veri beklenenden az');
      for (const needle of [SECRET, 'parolam', 'gizli.txt', a.store.state.deviceName, a.store.state.deviceId, text.id]) {
        assert.ok(!wire.includes(needle), `ağda açık görünüyor: ${needle}`);
      }
      return `${Math.round(wire.length / 1024)} KB ham veri tarandı`;
    });

    await step('şifreli dosya akışı: bozulma, kesilme ve yanlış anahtar fark ediliyor', async () => {
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

      assert.ok((await collect(piecemeal(sealed, 1000), decryptStream(key, 'file t'))).equals(plain), 'açılan veri farklı');
      const empty = await collect([], encryptStream(key, 'file e'));
      assert.strictEqual((await collect([empty], decryptStream(key, 'file e'))).length, 0, 'boş dosya');

      const fails = async (label, data, k = key, aad = 'file t') => {
        await assert.rejects(collect([data], decryptStream(k, aad)), undefined, `${label} fark edilmedi`);
      };
      const flipped = Buffer.from(sealed);
      flipped[100000] ^= 1;
      await fails('tek bit değişikliği', flipped);
      await fails('sondan kesilme', sealed.subarray(0, sealed.length - 70000));
      await fails('tam parça sınırından kesilme', sealed.subarray(0, 16 + 5 + 65536 + 16));
      await fails('yanlış anahtar', sealed, deriveKeys('BASKAKOD9999').enc);
      await fails('başka isteğe ait akış', sealed, key, 'file baska');
    });

    await step('tehlikeli dosya adları ve eski öğeler süzülüyor', async () => {
      const mk = (extra) => ({ id: crypto.randomUUID(), type: 'file', size: 1, from: { id: 'x', name: 'y' }, ts: Date.now(), ...extra });
      const evil = mk({ name: '..\\..\\Windows\\evil.exe' });
      const evil2 = mk({ name: '../../.ssh/authorized_keys' });
      b.store.addRemote(evil);
      b.store.addRemote(evil2);
      assert.strictEqual(b.store.get(evil.id).name, 'evil.exe');
      assert.strictEqual(b.store.get(evil2.id).name, 'authorized_keys');
      const old = mk({ name: 'eski.txt', ts: Date.now() - 30 * 24 * 3600 * 1000 });
      assert.strictEqual(b.store.addRemote(old), false, 'süresi dolmuş öğe kabul edildi');
      b.store.remove(evil.id);
      b.store.remove(evil2.id);
    });

    await reset();
    const bigSrc = path.join(root, 'buyuk.bin');
    const bigHash = await makeFile(bigSrc, 300);

    await step('300 MB dosya birebir ulaşıyor, iki tarafta da ilerleme bildiriliyor', async () => {
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
      await until(() => b.store.hasFile(file.id), 'dosya gelmedi', 60000);
      a.net.off('progress', wa);
      b.net.off('progress', wb);
      assert.strictEqual(await hashFile(b.store.filePath(file.id)), bigHash, 'içerik farklı');
      assert.ok(seen.in > 0, 'alıcıda ilerleme bildirilmedi');
      assert.ok(seen.out > 0, 'gönderende ilerleme bildirilmedi');
      await until(() => !Object.keys(a.net.transferState()).length && !Object.keys(b.net.transferState()).length, 'aktarım kaydı temizlenmedi', 3000);
    });

    await reset();
    await step('aktarım ortasında alıcı kapanıp açılınca dosya tamamlanıyor', async () => {
      b.net.once('progress', () => b.net.stop());
      const file = await a.store.addFile(bigSrc);
      a.net.publish(file);
      await sleep(1500);
      assert.ok(!b.store.hasFile(file.id), 'yarım dosya tamamlanmış sayıldı');
      await restart(b);
      await until(() => b.store.hasFile(file.id), 'yeniden açılınca tamamlanmadı', 60000);
      assert.strictEqual(await hashFile(b.store.filePath(file.id)), bigHash, 'içerik farklı');
      assert.deepStrictEqual(leftovers(b), [file.id], 'yarım dosya artığı kaldı');
    });

    await reset();
    await step('aktarım ortasında gönderen kapanıp açılınca dosya tamamlanıyor', async () => {
      b.net.once('progress', () => a.net.stop());
      const file = await a.store.addFile(bigSrc);
      a.net.publish(file);
      await sleep(1500);
      assert.ok(!b.store.hasFile(file.id), 'yarım dosya tamamlanmış sayıldı');
      await until(() => !Object.keys(b.net.transferState()).length, 'alıcıda aktarım askıda kaldı', 5000);
      await restart(a);
      await until(() => b.store.hasFile(file.id), 'gönderen dönünce tamamlanmadı', 60000);
      assert.strictEqual(await hashFile(b.store.filePath(file.id)), bigHash, 'içerik farklı');
    });

    await reset();
    await step('gönderen sessizce donarsa (uyku) aktarım askıda kalmıyor', async () => {
      // Başlıkları ve ilk parçayı yollayıp sonra susan sahte bir cihaz
      const frozen = http.createServer((req, res) => {
        res.writeHead(200);
        res.write(Buffer.alloc(10));
      });
      await new Promise((r) => frozen.listen(0, r));
      const item = { id: crypto.randomUUID(), type: 'file', name: 'donuk.bin', size: 50 * MB, from: { id: 'f', name: 'Donuk' }, ts: Date.now() };
      b.store.addRemote(item);
      b.net.stallMs = 1500;
      b.net.fetchFile({ id: 'f', host: '127.0.0.1', port: frozen.address().port }, b.store.get(item.id));
      await sleep(300);
      assert.ok(Object.keys(b.net.transferState()).length, 'aktarım başlamadı');
      await until(() => !Object.keys(b.net.transferState()).length, 'donmuş aktarım bırakılmadı', 6000);
      assert.ok(!leftovers(b).some((f) => f.startsWith(item.id)), 'yarım dosya artığı kaldı');
      frozen.closeAllConnections();
      frozen.close();
      b.store.remove(item.id);
    });

    await reset();
    await step('aktarım sırasında "tümünü temizle" artık bırakmıyor', async () => {
      b.net.once('progress', () => {
        const ts = Date.now();
        a.net.publishDelete(a.store.clear(ts), ts);
      });
      const file = await a.store.addFile(bigSrc);
      a.net.publish(file);
      await until(() => !a.store.state.items.length && !b.store.state.items.length, 'temizlenmedi', 10000);
      await until(() => !leftovers(a).length && !leftovers(b).length, `artık dosya kaldı: A=${leftovers(a)} B=${leftovers(b)}`, 10000);
    });
  } catch (err) {
    results.push(false);
    console.error('\n✗ BEKLENMEYEN HATA:', err.message);
  } finally {
    a.net.stop();
    b.net.stop();
    await sleep(200);
    fs.rmSync(root, { recursive: true, force: true });
  }

  const failed = results.filter((ok) => !ok).length;
  console.log(failed ? `\n${failed} adım başarısız.` : '\nTüm zorlama testleri geçti.');
  process.exitCode = failed ? 1 : 0;
})();
