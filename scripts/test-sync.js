// İki sanal cihazı aynı makinede ayağa kaldırıp eşitlemeyi uçtan uca dener.
// Çalıştır: npm test
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
    if (fn()) return;
    await sleep(50);
  }
  throw new Error(`zaman aşımı: ${label}`);
}

function device(root, name, code) {
  const store = new Store(path.join(root, name));
  store.set({ deviceName: name, ...(code ? { code } : {}) });
  return { store, net: new Net(store) };
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synctray-test-'));
  const a = device(root, 'Mac');
  const b = device(root, 'Windows', a.store.state.code);
  const stranger = device(root, 'Yabanci'); // farklı eşleşme kodu
  const all = [a, b, stranger];

  try {
    for (const d of all) await d.net.start();

    // 1. Keşif: önce UDP yayını, olmazsa elle adres
    let how = 'UDP yayını';
    try {
      await until(() => a.net.peers.size === 1 && b.net.peers.size === 1, 'keşif', 5000);
    } catch {
      how = 'elle adres (bu makinede yayın geri dönmüyor)';
      b.store.set({ manualPeers: [`127.0.0.1:${a.net.port}`] });
      b.net.tick();
      await until(() => a.net.peers.size === 1 && b.net.peers.size === 1, 'elle keşif');
    }
    console.log(`✓ cihazlar birbirini buldu (${how})`);

    // 2. Metin
    const text = await a.store.addText('const x = 42; // çğıöşü');
    a.net.publish(text);
    await until(() => b.store.get(text.id), 'metin');
    assert.strictEqual(b.store.get(text.id).text, text.text);
    assert.strictEqual(b.store.get(text.id).from.name, 'Mac');
    console.log('✓ metin karşı cihaza ulaştı');

    // 3. Dosya (5 MB rastgele veri, içerik özetiyle doğrulanır)
    const src = path.join(root, 'rapor.bin');
    const payload = crypto.randomBytes(5 * 1024 * 1024);
    fs.writeFileSync(src, payload);
    const file = await b.store.addFile(src);
    b.net.publish(file);
    await until(() => a.store.hasFile(file.id), 'dosya');
    const got = fs.readFileSync(a.store.filePath(file.id));
    assert.ok(got.equals(payload), 'dosya içeriği aynı olmalı');
    assert.strictEqual(a.store.get(file.id).name, 'rapor.bin');
    console.log('✓ dosya karşı cihaza ulaştı, içerik birebir aynı');

    // 4. Silme
    const ts = Date.now();
    a.store.remove(text.id, ts);
    a.net.publishDelete(text.id, ts);
    await until(() => !b.store.get(text.id), 'silme');
    console.log('✓ silme karşı cihaza yansıdı');

    // 5. Sonradan açılan cihaz geçmişi çeker
    const c = device(root, 'Tablet', a.store.state.code);
    all.push(c);
    await c.net.start();
    if (how !== 'UDP yayını') {
      c.store.set({ manualPeers: [`127.0.0.1:${a.net.port}`] });
      c.net.tick();
    }
    await until(() => c.store.hasFile(file.id), 'geç katılan cihaz');
    assert.ok(!c.store.get(text.id), 'silinen öğe geri gelmemeli');
    console.log('✓ sonradan açılan cihaz geçmişi ve dosyayı aldı');

    // 5b. Tümünü temizle
    a.net.publish(await a.store.addText('silinecek'));
    await until(() => b.store.state.items.length === 2, 'temizlik öncesi');
    const clearTs = Date.now();
    a.net.publishDelete(a.store.clear(clearTs), clearTs);
    await until(() => b.store.state.items.length === 0 && c.store.state.items.length === 0, 'tümünü temizle');
    await until(() => !b.store.hasFile(file.id) && !c.store.hasFile(file.id), 'dosyaların silinmesi');
    assert.strictEqual(a.store.state.items.length, 0);
    console.log('✓ tümünü temizle her cihazda listeyi ve dosyaları sildi');

    // 6. Yetkisiz erişim
    assert.strictEqual(stranger.net.peers.size, 0, 'farklı kodlu cihaz kimseyi görmemeli');
    assert.ok(!stranger.store.get(file.id));
    const raw = await fetch(`http://127.0.0.1:${a.net.port}/items`);
    assert.strictEqual(raw.status, 401);
    const forged = await stranger.net.request({ host: '127.0.0.1', port: a.net.port }, 'GET', '/items');
    assert.strictEqual(forged.status, 401);
    console.log('✓ eşleşme kodunu bilmeyen cihaz reddedildi');

    console.log('\nTüm testler geçti.');
  } catch (err) {
    console.error('\n✗ TEST BAŞARISIZ:', err.message);
    process.exitCode = 1;
  } finally {
    for (const d of all) d.net.stop();
    await sleep(100);
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
