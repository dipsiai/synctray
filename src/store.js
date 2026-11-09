// Yerel durum: cihaz kimliği, eşleşme kodu, paylaşılan öğeler ve dosyalar.
// Electron'a bağımlı değildir; düz Node ile de çalışır (testler bunu kullanır).
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const MAX_ITEMS = 50; // listede tutulan en fazla öğe; eskiler kendiliğinden düşer
const MAX_AGE = 7 * 24 * 3600 * 1000; // bu süreden eski öğeler silinir
const MAX_INLINE_TEXT = 100 * 1000; // daha uzun metinler .txt dosyası olarak gönderilir
const MAX_TEXT = 4 * 1024 * 1024;
const TOMBSTONE_TTL = 30 * 24 * 3600 * 1000;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Sıra her cihazda aynı çıkmalı: yeni olan üstte, aynı milisaniyede kimliğe göre.
const order = (a, b) => b.ts - a.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const RM = { force: true, maxRetries: 5, retryDelay: 200 }; // Windows'ta açık dosya için tekrar dener

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
      // ilk çalıştırma ya da bozuk dosya: varsayılanlarla devam
    }
    this.pruneTombstones();
    this.state.items.sort(order);
    this.expire();
    this.sweep();
    this.save();
  }

  // Aynı milisaniyede eklenenler bile ayrı zaman damgası alır.
  now() {
    this.lastTs = Math.max(Date.now(), (this.lastTs || 0) + 1);
    return this.lastTs;
  }

  // Süresi dolan öğeleri siler. Kural her cihazda aynı olduğu için duyurmaya gerek yok.
  expire() {
    const limit = Date.now() - MAX_AGE;
    const old = this.state.items.filter((i) => i.ts < limit);
    if (!old.length) return;
    this.state.items = this.state.items.filter((i) => i.ts >= limit);
    for (const item of old) this.deleteFile(item.id);
    this.changed();
  }

  // Hiçbir öğeye ait olmayan dosyaları ve yarım kalmış aktarımları temizler.
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
    if (!ID_RE.test(id)) throw new Error('geçersiz id');
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

  async addText(text) {
    if (text.length > MAX_INLINE_TEXT) {
      const d = new Date();
      const two = (n) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
      return this.addBuffer(`metin-${stamp}.txt`, Buffer.from(text, 'utf8'));
    }
    const item = { id: crypto.randomUUID(), type: 'text', text, from: this.device, ts: this.now() };
    this.insert(item);
    return item;
  }

  async addFile(srcPath, name) {
    const stat = await fs.promises.stat(srcPath);
    if (!stat.isFile()) throw new Error('Klasörler desteklenmiyor, önce zip yap');
    const id = crypto.randomUUID();
    // Destekleyen disklerde (APFS) anında klonlar, diğerlerinde normal kopyalar.
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

  async addBuffer(name, buffer) {
    const id = crypto.randomUUID();
    await fs.promises.writeFile(this.filePath(id), buffer);
    const item = {
      id,
      type: 'file',
      name: path.basename(name || 'dosya'),
      size: buffer.length,
      from: this.device,
      ts: this.now(),
    };
    this.insert(item);
    return item;
  }

  // Başka cihazdan gelen öğe. Yeni eklendiyse true döner.
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

  // Her şeyi siler; diğer cihazlara bildirmek için silinen id'leri döner.
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
    from: { id: raw.from.id.slice(0, 64), name: String(raw.from.name || 'Cihaz').slice(0, 40) },
    ts: raw.ts,
  };
  if (raw.type === 'text') {
    if (typeof raw.text !== 'string' || raw.text.length > MAX_TEXT) return null;
    return { ...base, text: raw.text };
  }
  if (raw.type === 'file') {
    const name = path.basename(String(raw.name || 'dosya').replace(/\\/g, '/')).slice(0, 255) || 'dosya';
    return { ...base, name, size: Number(raw.size) || 0 };
  }
  return null;
}

module.exports = { Store, normalizeCode };
