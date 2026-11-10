// Local state: device identity, pairing code, shared items and files.
// Does not depend on Electron; runs under plain Node too (the tests rely on this).
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const MAX_ITEMS = 50; // most items kept in the list; older ones drop off
const MAX_AGE = 7 * 24 * 3600 * 1000; // items older than this are deleted
const MAX_INLINE_TEXT = 100 * 1000; // longer texts are sent as a .txt file
const MAX_TEXT = 4 * 1024 * 1024;
const TOMBSTONE_TTL = 30 * 24 * 3600 * 1000;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// The order must come out identical on every device: newest first, ties broken by id.
const order = (a, b) => b.ts - a.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const RM = { force: true, maxRetries: 5, retryDelay: 200 }; // retries for files still open on Windows

function randomCode() {
  const bytes = crypto.randomBytes(12);
  return Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

class Store extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
    this.filesDir = path.join(dir, 'files');
    fs.mkdirSync(this.filesDir, { recursive: true });
    this.statePath = path.join(dir, 'state.json');
    this.state = {
      deviceId: crypto.randomUUID(),
      deviceName: os.hostname().replace(/\.local$/, ''),
      code: randomCode(),
      items: [],
      tombstones: {},
      manualPeers: [],
      pinned: false,
    };
    try {
      Object.assign(this.state, JSON.parse(fs.readFileSync(this.statePath, 'utf8')));
    } catch {
      // first run or corrupt file: continue with defaults
    }
    this.pruneTombstones();
    this.state.items.sort(order);
    this.expire();
    this.sweep();
    this.save();
  }

  // Items added in the same millisecond still get distinct timestamps.
  now() {
    this.lastTs = Math.max(Date.now(), (this.lastTs || 0) + 1);
    return this.lastTs;
  }

  // Deletes expired items. The rule is the same on every device, so nothing is announced.
  expire() {
    const limit = Date.now() - MAX_AGE;
    const old = this.state.items.filter((i) => i.ts < limit);
    if (!old.length) return;
    this.state.items = this.state.items.filter((i) => i.ts >= limit);
    for (const item of old) this.deleteFile(item.id);
    this.changed();
  }

  // Removes files that belong to no item, and leftovers of interrupted transfers.
  sweep() {
    const known = new Set(this.state.items.map((i) => i.id));
    for (const name of fs.readdirSync(this.filesDir)) {
      if (!known.has(name)) fs.rm(path.join(this.filesDir, name), RM, () => {});
    }
  }

  save() {
    const tmp = this.statePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.statePath);
  }

  changed() {
    this.save();
    this.emit('change');
  }

  get device() {
    return { id: this.state.deviceId, name: this.state.deviceName };
  }

  filePath(id) {
    if (!ID_RE.test(id)) throw new Error('invalid id');
    return path.join(this.filesDir, id);
  }

  hasFile(id) {
    return ID_RE.test(id) && fs.existsSync(path.join(this.filesDir, id));
  }

  get(id) {
    return this.state.items.find((i) => i.id === id);
  }

  list() {
    return this.state.items.map((i) => ({
      ...i,
      ready: i.type !== 'file' || this.hasFile(i.id),
      mine: i.from.id === this.state.deviceId,
    }));
  }

  // `from` defaults to this device; the web page for phones passes its own identity.
  async addText(text, from = this.device) {
    if (text.length > MAX_INLINE_TEXT) {
      const d = new Date();
      const two = (n) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
      return this.addBuffer(`text-${stamp}.txt`, Buffer.from(text, 'utf8'), from);
    }
    const item = { id: crypto.randomUUID(), type: 'text', text, from, ts: this.now() };
    this.insert(item);
    return item;
  }

  async addFile(srcPath, name) {
    const stat = await fs.promises.stat(srcPath);
    if (!stat.isFile()) throw Object.assign(new Error('folders are not supported'), { code: 'IS_DIRECTORY' });
    const id = crypto.randomUUID();
    // Clones instantly on disks that support it (APFS), plain copy elsewhere.
    await fs.promises.copyFile(srcPath, this.filePath(id), fs.constants.COPYFILE_FICLONE);
    const item = {
      id,
      type: 'file',
      name: path.basename(name || srcPath),
      size: stat.size,
      from: this.device,
      ts: this.now(),
    };
    this.insert(item);
    return item;
  }

  async addBuffer(name, buffer, from = this.device) {
    const id = crypto.randomUUID();
    await fs.promises.writeFile(this.filePath(id), buffer);
    return this.adopt(id, name, buffer.length, from);
  }

  // Registers a file that is already in place at filePath(id).
  adopt(id, name, size, from = this.device) {
    const clean = path.basename(String(name || 'file').replace(/\\/g, '/')).slice(0, 255) || 'file';
    const item = { id, type: 'file', name: clean, size, from, ts: this.now() };
    this.insert(item);
    return item;
  }

  // An item from another device. Returns true if it was new.
  addRemote(raw) {
    const item = sanitize(raw);
    if (!item) return false;
    if (this.get(item.id) || this.state.tombstones[item.id]) return false;
    if (item.ts < Date.now() - MAX_AGE) return false;
    const items = this.state.items;
    if (items.length >= MAX_ITEMS && order(item, items[items.length - 1]) > 0) return false;
    this.insert(item);
    return true;
  }

  insert(item) {
    const items = this.state.items;
    items.push(item);
    items.sort(order);
    for (const old of items.splice(MAX_ITEMS)) this.deleteFile(old.id);
    this.changed();
  }

  remove(id, ts = Date.now()) {
    if (!ID_RE.test(id)) return false;
    this.state.tombstones[id] = ts;
    const before = this.state.items.length;
    this.state.items = this.state.items.filter((i) => i.id !== id);
    this.deleteFile(id);
    this.changed();
    return this.state.items.length !== before;
  }

  applyTombstones(map) {
    let dirty = false;
    for (const [id, ts] of Object.entries(map || {})) {
      if (!ID_RE.test(id) || this.state.tombstones[id]) continue;
      this.state.tombstones[id] = Number(ts) || Date.now();
      this.state.items = this.state.items.filter((i) => i.id !== id);
      this.deleteFile(id);
      dirty = true;
    }
    if (dirty) this.changed();
  }

  // Deletes everything; returns the removed ids so other devices can be told.
  clear(ts = Date.now()) {
    const ids = this.state.items.map((i) => i.id);
    this.applyTombstones(Object.fromEntries(ids.map((id) => [id, ts])));
    return ids;
  }

  pruneTombstones() {
    const limit = Date.now() - TOMBSTONE_TTL;
    for (const [id, ts] of Object.entries(this.state.tombstones)) {
      if (ts < limit) delete this.state.tombstones[id];
    }
  }

  deleteFile(id) {
    for (const suffix of ['', '.part']) {
      fs.rm(path.join(this.filesDir, id + suffix), RM, () => {});
    }
  }

  set(patch) {
    if ('code' in patch) patch.code = normalizeCode(patch.code) || this.state.code;
    if ('deviceName' in patch) patch.deviceName = String(patch.deviceName).trim().slice(0, 40) || this.state.deviceName;
    Object.assign(this.state, patch);
    this.changed();
  }
}

function sanitize(raw) {
  if (!raw || typeof raw !== 'object' || !ID_RE.test(raw.id)) return null;
  if (!raw.from || typeof raw.from.id !== 'string' || typeof raw.ts !== 'number') return null;
  const base = {
    id: raw.id,
    type: raw.type,
    from: { id: raw.from.id.slice(0, 64), name: String(raw.from.name || 'Device').slice(0, 40) },
    ts: raw.ts,
  };
  if (raw.type === 'text') {
    if (typeof raw.text !== 'string' || raw.text.length > MAX_TEXT) return null;
    return { ...base, text: raw.text };
  }
  if (raw.type === 'file') {
    const name = path.basename(String(raw.name || 'file').replace(/\\/g, '/')).slice(0, 255) || 'file';
    return { ...base, name, size: Number(raw.size) || 0 };
  }
  return null;
}

module.exports = { Store, normalizeCode };
