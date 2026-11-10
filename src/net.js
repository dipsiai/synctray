// Local network layer: finds devices by UDP broadcast and syncs items over HTTP.
// Everything on the wire (requests, responses, files, device names) is encrypted with a key
// derived from the pairing code; see crypto.js.
// If internet sync is ever added, this is the only file that should need to change. Its public
// surface is start / stop / publish / publishDelete / peerList / transferState
// and the 'peers', 'incoming' and 'progress' events.
const { EventEmitter } = require('events');
const http = require('http');
const dgram = require('dgram');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { deriveKeys, seal, open, encryptStream, decryptStream } = require('./crypto');

const APP = 'synctray';
const PROTOCOL = 3; // different versions ignore each other rather than half-working
const HTTP_PORT = 47800;
const UDP_PORT = 47801;
const BEACON_MS = 3000;
const PEER_TIMEOUT_MS = 12000;
const SYNC_MS = 30000;
const RETRY_MS = 3000;
const MAX_CLOCK_SKEW_MS = 24 * 3600 * 1000;
const MAX_BODY = 16 * 1024 * 1024;
const PUSH_CHUNK = 2 * 1024 * 1024;
const MAX_TEXT = 4 * 1024 * 1024;

// The page phones and tablets open in their browser. It carries no secrets: the key arrives in
// the URL fragment (from the QR code), which browsers never send over the network.
const WEB_DIR = path.join(__dirname, 'web');
const VENDOR_DIR = path.join(__dirname, '..', 'node_modules', '@noble', 'ciphers');
const STATIC = {
  '/m': [WEB_DIR, 'index.html', 'text/html; charset=utf-8'],
  '/m/app.css': [WEB_DIR, 'app.css', 'text/css; charset=utf-8'],
  '/m/app.mjs': [WEB_DIR, 'app.mjs', 'text/javascript; charset=utf-8'],
  '/m/wire.mjs': [WEB_DIR, 'wire.mjs', 'text/javascript; charset=utf-8'],
  '/m/vendor/aes.js': [VENDOR_DIR, 'aes.js', 'text/javascript; charset=utf-8'],
  '/m/vendor/_polyval.js': [VENDOR_DIR, '_polyval.js', 'text/javascript; charset=utf-8'],
  '/m/vendor/utils.js': [VENDOR_DIR, 'utils.js', 'text/javascript; charset=utf-8'],
};

const RM = { force: true, maxRetries: 5, retryDelay: 100 };

class Net extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.peers = new Map();
    this.transfers = new Map(); // anahtar → { id, dir: 'in' | 'out', done, total, abort }
    this.syncing = new Set();
    this.retries = new Map();
    this.timers = [];
    this.port = 0;
    this.running = false;
    this.stallMs = 20000; // a transfer with no data for this long is dropped and retried
    this.onStoreChange = () => this.abortOrphans();
  }

  // Keys derived from the pairing code; devices without the code can neither see nor reach us.
  // Derivation is deliberately slow, so the result is cached until the code changes.
  keys() {
    const { code } = this.store.state;
    if (this.keysFor !== code) {
      this.cachedKeys = deriveKeys(code);
      this.keysFor = code;
    }
    return this.cachedKeys;
  }

  group() {
    return this.keys().group;
  }

  // Sealed header of every request: who and when. Bound to the method and path.
  // The returned `nonce` identifies the request; body, response and file stream are bound to it.
  sealHeader(method, pathname) {
    const { id, name } = this.store.device;
    const meta = JSON.stringify({ ts: Date.now(), id, name, port: this.port });
    const box = seal(this.keys().enc, meta, `req ${method} ${pathname}`);
    return { header: box.toString('base64'), nonce: box.subarray(0, 12).toString('hex') };
  }

  openHeader(req, pathname) {
    try {
      const box = Buffer.from(String(req.headers['x-seal'] || ''), 'base64');
      const meta = JSON.parse(open(this.keys().enc, box, `req ${req.method} ${pathname}`));
      if (Math.abs(Date.now() - meta.ts) > MAX_CLOCK_SKEW_MS) return null;
      return { meta, nonce: box.subarray(0, 12).toString('hex') };
    } catch {
      return null;
    }
  }

  async start() {
    this.running = true;
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    this.port = await listen(this.server, HTTP_PORT).catch(() => listen(this.server, 0));

    this.udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.udp.on('error', () => {});
    this.udp.on('message', (msg, rinfo) => this.onBeacon(msg, rinfo));
    this.udp.bind(UDP_PORT, () => {
      try {
        this.udp.setBroadcast(true);
      } catch {
        // if broadcast is unavailable, manually added devices still work
      }
      this.beacon();
    });

    this.store.on('change', this.onStoreChange);
    this.timers = [
      setInterval(() => this.beacon(), BEACON_MS),
      setInterval(() => this.tick(), 5000),
      setInterval(() => this.syncAll(), SYNC_MS),
    ];
    this.tick();
  }

  stop() {
    this.running = false;
    this.store.off('change', this.onStoreChange);
    this.timers.forEach(clearInterval);
    this.retries.forEach(clearTimeout);
    this.retries.clear();
    clearTimeout(this.progressTimer);
    for (const t of this.transfers.values()) t.abort();
    this.server?.close();
    this.server?.closeAllConnections?.();
    try {
      this.udp?.close();
    } catch {
      // already closed
    }
  }

  // When the pairing code changes, forget the devices of the old group.
  reset() {
    this.peers.clear();
    this.emit('peers');
    this.beacon();
    this.tick();
  }

  localIPs() {
    return Object.values(os.networkInterfaces())
      .flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal);
  }

  // ---- Discovery ----

  beacon() {
    if (!this.udp || !this.running) return;
    const { id, name } = this.store.device;
    const box = seal(this.keys().enc, JSON.stringify({ id, name, port: this.port }), 'beacon').toString('base64');
    const msg = Buffer.from(JSON.stringify({ app: APP, v: PROTOCOL, group: this.group(), box }));
    const targets = new Set(['255.255.255.255']);
    for (const i of this.localIPs()) {
      const ip = i.address.split('.').map(Number);
      const mask = i.netmask.split('.').map(Number);
      targets.add(ip.map((b, k) => (b | (~mask[k] & 255))).join('.'));
    }
    for (const t of targets) this.udp.send(msg, UDP_PORT, t, () => {});
  }

  onBeacon(msg, rinfo) {
    let m;
    try {
      m = JSON.parse(msg.toString());
    } catch {
      return;
    }
    if (!m || m.app !== APP || m.v !== PROTOCOL || m.group !== this.group()) return;
    try {
      const info = JSON.parse(open(this.keys().enc, Buffer.from(String(m.box), 'base64'), 'beacon'));
      this.upsert(String(info.id), String(info.name || 'Device'), rinfo.address, Number(info.port));
    } catch {
      // someone without the code is imitating a device, or the packet is corrupt
    }
  }

  upsert(id, name, host, port) {
    if (!this.running || !id || !port || id === this.store.device.id) return;
    const known = this.peers.get(id);
    const peer = { id, name: name.slice(0, 40), host, port, lastSeen: Date.now() };
    this.peers.set(id, peer);
    if (!known) {
      this.emit('peers');
      this.syncWith(peer);
    } else if (known.name !== peer.name || known.host !== host || known.port !== port) {
      this.emit('peers');
    }
  }

  tick() {
    const limit = Date.now() - PEER_TIMEOUT_MS;
    let dropped = false;
    for (const [id, p] of this.peers) {
      if (p.lastSeen < limit) {
        this.peers.delete(id);
        dropped = true;
      }
    }
    if (dropped) this.emit('peers');

    // Where broadcast is blocked (guest network, firewall), poll manually entered addresses.
    for (const entry of this.store.state.manualPeers) {
      const [host, port] = entry.split(':');
      const target = { host, port: Number(port) || HTTP_PORT };
      this.request(target, 'GET', '/ping')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d && d.v === PROTOCOL && this.upsert(String(d.id), String(d.name || 'Device'), target.host, target.port))
        .catch(() => {});
    }
  }

  peerList() {
    return [...this.peers.values()].map(({ id, name, host }) => ({ id, name, host }));
  }

  // ---- Sync ----

  async request(peer, method, pathname, data) {
    const { enc } = this.keys();
    const { header, nonce } = this.sealHeader(method, pathname);
    const res = await fetch(`http://${peer.host}:${peer.port}${pathname}`, {
      method,
      headers: { 'x-seal': header, 'content-type': 'application/octet-stream' },
      body: data ? seal(enc, JSON.stringify(data), `body ${nonce}`) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    return {
      ok: res.ok,
      status: res.status,
      // The response is sealed for this request only; an old response cannot be replayed.
      json: async () => JSON.parse(open(enc, Buffer.from(await res.arrayBuffer()), `resp ${nonce}`)),
    };
  }

  async send(peer, pathname, data) {
    const res = await this.request(peer, 'POST', pathname, data);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  // Immediate notification. If it does not arrive, a full sync shortly after makes up for it.
  publish(item) {
    for (const peer of this.peers.values()) {
      this.send(peer, '/items', { items: [item] }).catch(() => this.syncSoon(peer.id));
    }
  }

  publishDelete(ids, ts) {
    for (const peer of this.peers.values()) {
      this.send(peer, '/delete', { ids: [].concat(ids), ts }).catch(() => this.syncSoon(peer.id));
    }
  }

  syncSoon(peerId, delay = RETRY_MS) {
    if (!this.running || this.retries.has(peerId)) return;
    const timer = setTimeout(() => {
      this.retries.delete(peerId);
      const peer = this.peers.get(peerId);
      if (peer) this.syncWith(peer);
    }, delay);
    timer.unref?.();
    this.retries.set(peerId, timer);
  }

  syncAll() {
    for (const peer of this.peers.values()) this.syncWith(peer);
  }

  // Two-way: pulls what the peer has and we lack, pushes what we have and the peer lacks.
  // Only the id list is fetched first; content travels only for what is missing.
  async syncWith(peer) {
    if (!this.running || this.syncing.has(peer.id)) return;
    this.syncing.add(peer.id);
    try {
      const res = await this.request(peer, 'GET', '/index');
      if (!res.ok) return;
      const index = await res.json();
      const tombstones = index.tombstones || {};
      this.store.applyTombstones(tombstones);

      const theirs = new Set(index.ids || []);
      const missing = [...theirs].filter((id) => !this.store.get(id) && !this.store.state.tombstones[id]);
      if (missing.length) {
        const got = await this.request(peer, 'POST', '/get', { ids: missing });
        if (got.ok) for (const raw of (await got.json()).items || []) this.store.addRemote(raw);
      }

      const theirFiles = new Set(index.files || []);
      for (const item of this.store.state.items) {
        if (item.type === 'file' && theirFiles.has(item.id) && !this.store.hasFile(item.id)) this.fetchFile(peer, item);
      }

      const extra = this.store.state.items.filter((i) => !theirs.has(i.id) && !tombstones[i.id]);
      for (const items of chunkBySize(extra, PUSH_CHUNK)) await this.send(peer, '/items', { items });
    } catch {
      // the device may have gone to sleep; retried on the next round
    } finally {
      this.syncing.delete(peer.id);
    }
  }

  // ---- File transfer ----

  // Per-item summary: { [id]: { dir, done, total } }
  transferState() {
    const out = {};
    for (const t of this.transfers.values()) {
      const sum = (out[t.id] ||= { dir: t.dir, done: 0, total: 0 });
      sum.done += t.done;
      sum.total += t.total;
    }
    return out;
  }

  emitProgress(now = false) {
    if (now) {
      clearTimeout(this.progressTimer);
      this.progressTimer = null;
      return this.emit('progress');
    }
    if (this.progressTimer) return;
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null;
      this.emit('progress');
    }, 120);
  }

  counter(transfer, onChunk) {
    return new Transform({
      transform: (chunk, _enc, done) => {
        transfer.done += chunk.length;
        onChunk?.();
        this.emitProgress();
        done(null, chunk);
      },
    });
  }

  // Abort transfers whose item was deleted (e.g. "clear all" during a transfer).
  abortOrphans() {
    for (const t of this.transfers.values()) {
      if (!this.store.get(t.id)) t.abort();
    }
  }

  async fetchFile(peer, item) {
    const key = `in:${item.id}`;
    if (!this.running || this.transfers.has(key) || this.store.hasFile(item.id)) return;

    const ctrl = new AbortController();
    const transfer = { id: item.id, dir: 'in', done: 0, total: item.size, abort: () => ctrl.abort() };
    this.transfers.set(key, transfer);
    this.emitProgress();

    let stall;
    const arm = () => {
      clearTimeout(stall);
      stall = setTimeout(() => ctrl.abort(), this.stallMs);
    };
    arm();

    const dest = this.store.filePath(item.id);
    const part = dest + '.part';
    let ok = false;
    let retry = true;
    try {
      const pathname = `/files/${item.id}`;
      const { header, nonce } = this.sealHeader('GET', pathname);
      const res = await fetch(`http://${peer.host}:${peer.port}${pathname}`, {
        headers: { 'x-seal': header },
        signal: ctrl.signal,
      });
      if (res.status === 404) retry = false; // the peer does not have it either; it arrives when the original sender returns
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pipeline(
        Readable.fromWeb(res.body),
        decryptStream(this.keys().enc, `file ${nonce}`),
        this.counter(transfer, arm),
        fs.createWriteStream(part),
        { signal: ctrl.signal }
      );
      if (transfer.done !== item.size) throw new Error('incomplete transfer');
      if (this.store.get(item.id)) {
        await fs.promises.rename(part, dest);
        ok = true;
      }
    } catch {
      // cleaned up below and retried if needed
    } finally {
      clearTimeout(stall);
      if (!ok) await fs.promises.rm(part, RM).catch(() => {});
      this.transfers.delete(key);
      this.emitProgress(true);
      if (ok) this.store.emit('change');
      else if (retry && this.store.get(item.id)) this.syncSoon(peer.id);
    }
  }

  async serveFile(res, id, peer, nonce, web = false) {
    const file = this.store.filePath(id);
    const { size } = await fs.promises.stat(file);
    const stream = fs.createReadStream(file);
    const key = `out:${id}:${peer.id}:${crypto.randomUUID()}`;
    const transfer = { id, dir: 'out', done: 0, total: size, abort: () => stream.destroy() };
    this.transfers.set(key, transfer);
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    try {
      const key = web ? this.keys().web : this.keys().enc;
      await pipeline(stream, this.counter(transfer), encryptStream(key, `file ${nonce}`, { web }), res);
    } catch {
      // the receiver dropped the connection; it will ask again
    } finally {
      this.transfers.delete(key);
      this.emitProgress(true);
    }
  }

  // ---- Phones and tablets (browser) ----

  // Link for the QR code. The key sits in the fragment, so it never leaves the phone.
  webLink() {
    const [ip] = this.localIPs();
    return ip ? `http://${ip.address}:${this.port}/m#${this.keys().web.toString('base64url')}` : null;
  }

  serveStatic(res, pathname) {
    const entry = STATIC[pathname];
    if (!entry) return false;
    const [dir, name, type] = entry;
    fs.readFile(path.join(dir, name), (err, body) => {
      if (err) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, {
        'content-type': type,
        'cache-control': 'no-cache',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; img-src 'self' blob: data:; frame-ancestors 'none'",
      });
      res.end(body);
    });
    return true;
  }

  // Same sealed-request scheme as between devices, but with the web key and its own routes.
  async handleWeb(req, res, pathname) {
    const { web } = this.keys();
    const deny = () => {
      res.writeHead(401);
      res.end();
    };
    let meta;
    let nonce;
    try {
      const box = Buffer.from(String(req.headers['x-seal'] || ''), 'base64');
      meta = JSON.parse(open(web, box, `web ${req.method} ${pathname}`));
      nonce = box.subarray(0, 12).toString('hex');
      if (Math.abs(Date.now() - meta.ts) > MAX_CLOCK_SKEW_MS) return deny();
    } catch {
      return deny();
    }

    const json = (code, payload) => {
      res.writeHead(code, { 'content-type': 'application/octet-stream' });
      res.end(seal(web, JSON.stringify(payload), `resp ${nonce}`));
    };
    const from = {
      id: `web-${String(meta.device || '').replace(/[^\w-]/g, '').slice(0, 40)}`,
      name: String(meta.name || 'Phone').slice(0, 40),
    };
    const announce = (item) => {
      this.publish(item);
      this.emit('incoming', [item]);
    };

    if (req.method === 'GET' && pathname.startsWith('/w/file/')) {
      const id = pathname.slice('/w/file/'.length);
      if (!this.store.hasFile(id)) return json(404, { error: 'not found' });
      return this.serveFile(res, id, from, nonce, true);
    }

    if (req.method === 'POST' && pathname === '/w/upload') {
      const id = crypto.randomUUID();
      const dest = this.store.filePath(id);
      const part = dest + '.part';
      try {
        await pipeline(req, decryptStream(web, `file ${nonce}`, { web: true }), fs.createWriteStream(part));
        const { size } = await fs.promises.stat(part);
        await fs.promises.rename(part, dest);
        announce(this.store.adopt(id, meta.fileName, size, from));
        return json(200, { ok: true, id });
      } catch {
        await fs.promises.rm(part, RM).catch(() => {});
        return json(400, { error: 'upload failed' });
      }
    }

    if (req.method !== 'POST') return json(404, { error: 'unknown path' });
    let data;
    try {
      data = JSON.parse(open(web, await readBody(req), `body ${nonce}`)) || {};
    } catch {
      return deny();
    }

    if (pathname === '/w/list') {
      return json(200, { device: this.store.device.name, me: from.id, items: this.store.list() });
    }

    if (pathname === '/w/text') {
      const text = typeof data.text === 'string' ? data.text : '';
      if (!text.trim() || text.length > MAX_TEXT) return json(400, { error: 'bad text' });
      const item = await this.store.addText(text, from);
      announce(item);
      return json(200, { ok: true, id: item.id });
    }

    if (pathname === '/w/delete') {
      const ts = Date.now();
      if (this.store.remove(String(data.id), ts)) this.publishDelete(data.id, ts);
      return json(200, { ok: true });
    }

    json(404, { error: 'unknown path' });
  }

  // ---- Server ----

  async handle(req, res) {
    const pathname = new URL(req.url, 'http://x').pathname;
    if (req.method === 'GET' && this.serveStatic(res, pathname)) return;
    if (pathname.startsWith('/w/')) return this.handleWeb(req, res, pathname);

    const { enc } = this.keys();
    const deny = () => {
      res.writeHead(401);
      res.end();
    };

    // The body is not read until the header opens: a stranger cannot make us buffer data.
    const auth = this.openHeader(req, pathname);
    if (!auth) return deny();
    const { meta, nonce } = auth;

    let data = {};
    if (req.method === 'POST') {
      try {
        data = JSON.parse(open(enc, await readBody(req), `body ${nonce}`)) || {};
      } catch {
        return deny();
      }
    }

    // Also learn about the requesting device, so entering an IP on one side is enough.
    const peer = {
      id: String(meta.id || ''),
      name: String(meta.name || 'Device'),
      host: (req.socket.remoteAddress || '').replace(/^::ffff:/, ''),
      port: Number(meta.port),
    };
    this.upsert(peer.id, peer.name, peer.host, peer.port);

    const json = (code, payload) => {
      res.writeHead(code, { 'content-type': 'application/octet-stream' });
      res.end(seal(enc, JSON.stringify(payload), `resp ${nonce}`));
    };
    const route = `${req.method} ${pathname}`;

    if (route === 'GET /ping') return json(200, { ...this.store.device, v: PROTOCOL });

    if (route === 'GET /index') {
      const items = this.store.state.items;
      return json(200, {
        ids: items.map((i) => i.id),
        files: items.filter((i) => i.type === 'file' && this.store.hasFile(i.id)).map((i) => i.id),
        tombstones: this.store.state.tombstones,
      });
    }

    if (route === 'POST /get') {
      const wanted = new Set(Array.isArray(data.ids) ? data.ids : []);
      return json(200, { items: this.store.state.items.filter((i) => wanted.has(i.id)) });
    }

    if (route === 'POST /items') {
      const added = [];
      for (const raw of Array.isArray(data.items) ? data.items : []) {
        if (this.store.addRemote(raw)) added.push(this.store.get(raw.id));
      }
      if (added.length) this.emit('incoming', added);
      for (const item of added) if (item.type === 'file') this.fetchFile(peer, item);
      return json(200, { ok: true });
    }

    if (route === 'POST /delete') {
      if (Array.isArray(data.ids)) this.store.applyTombstones(Object.fromEntries(data.ids.map((id) => [id, data.ts])));
      return json(200, { ok: true });
    }

    if (req.method === 'GET' && pathname.startsWith('/files/')) {
      const id = pathname.slice('/files/'.length);
      if (!this.store.hasFile(id)) return json(404, { error: 'not found' });
      return this.serveFile(res, id, peer, nonce);
    }

    json(404, { error: 'unknown path' });
  }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, () => {
      server.off('error', onError);
      resolve(server.address().port);
    });
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function* chunkBySize(items, limit) {
  let batch = [];
  let size = 0;
  for (const item of items) {
    const weight = (item.text ? item.text.length * 3 : 0) + 300;
    if (batch.length && size + weight > limit) {
      yield batch;
      batch = [];
      size = 0;
    }
    batch.push(item);
    size += weight;
  }
  if (batch.length) yield batch;
}

module.exports = { Net, HTTP_PORT };
