// The page a phone or tablet opens from the QR code. Talks to the desktop app over the
// local network; every request, response and file is encrypted with the key from the QR code.
import { gcm } from './vendor/aes.js';
import { makeWire } from './wire.mjs';

const STRINGS = {
  en: {
    placeholder: 'Paste or type text…',
    pick: 'Send file',
    send: 'Send',
    copy: 'Copy',
    save: 'Save',
    empty: 'Nothing shared yet.',
    connected: 'Connected to {name}',
    offline: 'Cannot reach the computer…',
    noKey: 'Open this page by scanning the QR code in SyncTray on your computer:\nSettings → Phone and tablet.',
    badKey: 'This link no longer works. The pairing code may have changed.\nScan the QR code again.',
    copied: 'Copied',
    copyFailed: 'Could not copy; select the text manually',
    sent: 'Sent',
    failed: 'Something went wrong',
    downloading: 'Downloading…',
    uploading: 'Sending {name}…',
    tooBig: '{name} is too large to send from the browser (limit {mb} MB)',
    notReady: 'Not transferred yet',
    thisDevice: 'This device',
    now: 'now',
    minAgo: '{n} min ago',
    hourAgo: '{n} h ago',
    locale: 'en-US',
  },
  tr: {
    placeholder: 'Metni yapıştır ya da yaz…',
    pick: 'Dosya gönder',
    send: 'Gönder',
    copy: 'Kopyala',
    save: 'Kaydet',
    empty: 'Henüz bir şey paylaşılmadı.',
    connected: '{name} bağlı',
    offline: 'Bilgisayara ulaşılamıyor…',
    noKey: 'Bu sayfayı bilgisayarındaki SyncTray\'de QR kodu okutarak aç:\nAyarlar → Telefon ve tablet.',
    badKey: 'Bu bağlantı artık çalışmıyor. Eşleşme kodu değişmiş olabilir.\nQR kodu yeniden okut.',
    copied: 'Kopyalandı',
    copyFailed: 'Kopyalanamadı; metni elle seç',
    sent: 'Gönderildi',
    failed: 'Bir şeyler ters gitti',
    downloading: 'İndiriliyor…',
    uploading: '{name} gönderiliyor…',
    tooBig: '{name} tarayıcıdan göndermek için çok büyük (sınır {mb} MB)',
    notReady: 'Henüz aktarılmadı',
    thisDevice: 'Bu cihaz',
    now: 'şimdi',
    minAgo: '{n} dk önce',
    hourAgo: '{n} sa önce',
    locale: 'tr-TR',
  },
};

const MAX_UPLOAD_MB = 300; // the whole file is held in memory while it is encrypted
const KEY_STORE = 'synctray-key';
const DEVICE_STORE = 'synctray-device';

const lang = (navigator.language || '').toLowerCase().startsWith('tr') ? 'tr' : 'en';
const t = (key, vars = {}) => STRINGS[lang][key].replace(/\{(\w+)\}/g, (_m, k) => vars[k] ?? '');
const $ = (id) => document.getElementById(id);
const decoder = new TextDecoder();

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

let toastTimer;
function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').hidden = true), 2400);
}

function showNotice(message) {
  $('app').hidden = true;
  $('notice').textContent = message;
  $('notice').hidden = false;
}

// ---- Key and identity ----

function fromBase64Url(text) {
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function loadKey() {
  // Move the key out of the address bar so it is not shared or bookmarked by accident.
  const fragment = location.hash.slice(1);
  if (fragment) {
    try {
      localStorage.setItem(KEY_STORE, fragment);
    } catch {
      // private mode: keep working for this visit
    }
    history.replaceState(null, '', location.pathname);
  }
  const stored = fragment || localStorage.getItem(KEY_STORE);
  if (!stored) return null;
  try {
    const key = fromBase64Url(stored);
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

function identity() {
  let device = localStorage.getItem(DEVICE_STORE);
  if (!device) {
    device = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(DEVICE_STORE, device);
  }
  const ua = navigator.userAgent;
  const name = /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : 'Browser';
  return { device, name };
}

// ---- Talking to the computer ----

const key = loadKey();
const wire = key && makeWire(gcm, key);
const me = key && identity();

class AuthError extends Error {}

async function call(path, data = {}) {
  const { header, nonce } = wire.header('POST', path, me);
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'x-seal': header },
    body: wire.seal(JSON.stringify(data), `body ${nonce}`),
  });
  if (res.status === 401) throw new AuthError();
  const body = new Uint8Array(await res.arrayBuffer());
  const payload = JSON.parse(decoder.decode(wire.open(body, `resp ${nonce}`)));
  if (!res.ok) throw new Error(payload.error || 'request failed');
  return payload;
}

async function download(item) {
  const path = `/w/file/${item.id}`;
  const { header, nonce } = wire.header('GET', path, me);
  const res = await fetch(path, { headers: { 'x-seal': header } });
  if (!res.ok) throw new Error('download failed');
  const chunks = wire.decryptFile(new Uint8Array(await res.arrayBuffer()), `file ${nonce}`);
  const url = URL.createObjectURL(new Blob(chunks));
  const link = el('a', { href: url, download: item.name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function upload(file) {
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) return toast(t('tooBig', { name: file.name, mb: MAX_UPLOAD_MB }));
  toast(t('uploading', { name: file.name }));
  const { header, nonce } = wire.header('POST', '/w/upload', { ...me, fileName: file.name });
  const parts = wire.encryptFile(new Uint8Array(await file.arrayBuffer()), `file ${nonce}`);
  const res = await fetch('/w/upload', { method: 'POST', headers: { 'x-seal': header }, body: new Blob(parts) });
  if (!res.ok) throw new Error('upload failed');
}

// ---- Rendering ----

function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

function formatTime(ts) {
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 60e3) return t('now');
  if (diff < 3600e3) return t('minAgo', { n: Math.floor(diff / 60e3) });
  if (diff < 24 * 3600e3) return t('hourAgo', { n: Math.floor(diff / 3600e3) });
  return new Date(ts).toLocaleDateString(t('locale'), { day: 'numeric', month: 'short' });
}

// navigator.clipboard needs HTTPS, so fall back to the selection-based copy.
function copyText(text) {
  const area = el('textarea', { value: text, readOnly: true });
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.append(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  toast(t(ok ? 'copied' : 'copyFailed'));
}

function renderItem(item, myId) {
  const who = item.from.id === myId ? t('thisDevice') : item.from.name;
  const meta = el('div', { className: 'meta' });
  let body;
  let button;
  if (item.type === 'text') {
    body = el('pre', { textContent: item.text.length > 800 ? `${item.text.slice(0, 800)}…` : item.text });
    meta.append(el('span', { textContent: `${who} · ${formatTime(item.ts)}` }));
    button = el('button', { className: 'btn small', textContent: t('copy') });
    button.onclick = () => copyText(item.text);
  } else {
    body = el('div', { className: 'name', textContent: item.name });
    const status = item.ready ? `${who} · ${formatTime(item.ts)}` : t('notReady');
    meta.append(el('span', { textContent: `${formatSize(item.size)} · ${status}` }));
    button = el('button', { className: 'btn small', textContent: t('save'), disabled: !item.ready });
    button.onclick = async () => {
      button.disabled = true;
      toast(t('downloading'));
      try {
        await download(item);
      } catch {
        toast(t('failed'));
      }
      button.disabled = false;
    };
  }
  meta.append(button);
  return el('li', { className: 'item' }, body, meta);
}

let lastSnapshot = '';

async function refresh() {
  try {
    const data = await call('/w/list');
    $('dot').classList.add('online');
    $('status').textContent = t('connected', { name: data.device });
    const snapshot = JSON.stringify(data.items.map((i) => [i.id, i.ready]));
    if (snapshot !== lastSnapshot) {
      // Redraw only when something changed, so a tap is never lost to a re-render.
      lastSnapshot = snapshot;
      $('list').replaceChildren(...data.items.map((item) => renderItem(item, data.me)));
      $('empty').hidden = data.items.length > 0;
    }
  } catch (err) {
    if (err instanceof AuthError) {
      clearInterval(timer);
      localStorage.removeItem(KEY_STORE);
      return showNotice(t('badKey'));
    }
    $('dot').classList.remove('online');
    $('status').textContent = t('offline');
  }
}

// ---- Start ----

let timer;
document.documentElement.lang = lang;

if (!wire) {
  showNotice(t('noKey'));
} else {
  const input = $('input');
  input.placeholder = t('placeholder');
  $('pick-text').textContent = t('pick');
  $('send').textContent = t('send');
  $('empty').textContent = t('empty');
  $('app').hidden = false;

  input.addEventListener('input', () => ($('send').disabled = !input.value.trim()));
  $('send').onclick = async () => {
    const text = input.value;
    if (!text.trim()) return;
    $('send').disabled = true;
    try {
      await call('/w/text', { text });
      input.value = '';
      toast(t('sent'));
      refresh();
    } catch {
      toast(t('failed'));
      $('send').disabled = false;
    }
  };

  $('pick').onchange = async (event) => {
    for (const file of event.target.files) {
      try {
        await upload(file);
        toast(t('sent'));
      } catch {
        toast(t('failed'));
      }
    }
    event.target.value = '';
    refresh();
  };

  refresh();
  timer = setInterval(() => document.visibilityState === 'visible' && refresh(), 3000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refresh());
}
