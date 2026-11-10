// End-to-end sync test: starts several virtual devices on this machine.
// Run: npm test
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
  throw new Error(`timed out: ${label}`);
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
  const stranger = device(root, 'Stranger'); // different pairing code
  const all = [a, b, stranger];

  try {
    for (const d of all) await d.net.start();

    // 1. Discovery: UDP broadcast first, manual address as a fallback
    let how = 'UDP broadcast';
    try {
      await until(() => a.net.peers.size === 1 && b.net.peers.size === 1, 'discovery', 5000);
    } catch {
      how = 'manual address (broadcast does not loop back on this machine)';
      b.store.set({ manualPeers: [`127.0.0.1:${a.net.port}`] });
      b.net.tick();
      await until(() => a.net.peers.size === 1 && b.net.peers.size === 1, 'manual discovery');
    }
    console.log(`✓ devices found each other (${how})`);

    // 2. Text
    const text = await a.store.addText('const x = 42; // çğıöşü');
    a.net.publish(text);
    await until(() => b.store.get(text.id), 'text');
    assert.strictEqual(b.store.get(text.id).text, text.text);
    assert.strictEqual(b.store.get(text.id).from.name, 'Mac');
    console.log('✓ text reached the other device');

    // 3. File (5 MB of random data, compared byte for byte)
    const src = path.join(root, 'report.bin');
    const payload = crypto.randomBytes(5 * 1024 * 1024);
    fs.writeFileSync(src, payload);
    const file = await b.store.addFile(src);
    b.net.publish(file);
    await until(() => a.store.hasFile(file.id), 'file');
    const got = fs.readFileSync(a.store.filePath(file.id));
    assert.ok(got.equals(payload), 'file contents must match');
    assert.strictEqual(a.store.get(file.id).name, 'report.bin');
    console.log('✓ file reached the other device, contents identical');

    // 4. Delete
    const ts = Date.now();
    a.store.remove(text.id, ts);
    a.net.publishDelete(text.id, ts);
    await until(() => !b.store.get(text.id), 'delete');
    console.log('✓ delete propagated to the other device');

    // 5. A device that starts later pulls the history
    const c = device(root, 'Tablet', a.store.state.code);
    all.push(c);
    await c.net.start();
    if (how !== 'UDP broadcast') {
      c.store.set({ manualPeers: [`127.0.0.1:${a.net.port}`] });
      c.net.tick();
    }
    await until(() => c.store.hasFile(file.id), 'late joiner');
    assert.ok(!c.store.get(text.id), 'a deleted item must not come back');
    console.log('✓ late joiner received the history and the file');

    // 5b. Clear all
    a.net.publish(await a.store.addText('to be deleted'));
    await until(() => b.store.state.items.length === 2, 'before clear');
    const clearTs = Date.now();
    a.net.publishDelete(a.store.clear(clearTs), clearTs);
    await until(() => b.store.state.items.length === 0 && c.store.state.items.length === 0, 'clear all');
    await until(() => !b.store.hasFile(file.id) && !c.store.hasFile(file.id), 'file removal');
    assert.strictEqual(a.store.state.items.length, 0);
    console.log('✓ clear all removed the list and files on every device');

    // 6. Unauthorized access
    assert.strictEqual(stranger.net.peers.size, 0, 'a device with a different code must see nobody');
    assert.ok(!stranger.store.get(file.id));
    const raw = await fetch(`http://127.0.0.1:${a.net.port}/items`);
    assert.strictEqual(raw.status, 401);
    const forged = await stranger.net.request({ host: '127.0.0.1', port: a.net.port }, 'GET', '/items');
    assert.strictEqual(forged.status, 401);
    console.log('✓ device without the pairing code was rejected');

    // 7. Sleep and wake: an asleep device is silent and unreachable, then catches up
    const oldPort = c.net.port;
    await c.net.sleep();
    assert.strictEqual(c.net.peers.size, 0);
    await assert.rejects(fetch(`http://127.0.0.1:${oldPort}/m`), 'an asleep device must not listen');
    const whileAsleep = await a.store.addText('sent while the tablet slept');
    a.net.publish(whileAsleep);
    const fromSleeper = await c.store.addText('written while asleep');
    c.net.publish(fromSleeper);
    await sleep(1500);
    assert.ok(!c.store.get(whileAsleep.id), 'an asleep device must not receive');
    assert.ok(!a.store.get(fromSleeper.id), 'an asleep device must not send');
    await c.net.wake();
    await until(() => c.store.get(whileAsleep.id) && a.store.get(fromSleeper.id), 'catch up after waking');
    console.log('✓ asleep device was silent, then caught up in both directions after waking');

    console.log('\nAll tests passed.');
  } catch (err) {
    console.error('\n✗ TEST FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    for (const d of all) d.net.stop();
    await sleep(100);
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
