const $ = (id) => document.getElementById(id);
// `api` preload.js tarafından global olarak sağlanır.

let state = null;
let transfers = {};
let toastTimer = null;

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), 2200);
}

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
  if (diff < 60e3) return 'şimdi';
  if (diff < 3600e3) return `${Math.floor(diff / 60e3)} dk önce`;
  if (diff < 24 * 3600e3) return `${Math.floor(diff / 3600e3)} sa önce`;
  return new Date(ts).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
}

function formatCode(code) {
  return code.replace(/(.{4})(?=.)/g, '$1-');
}

async function copyItem(id) {
  if (await api.call('copy', id)) showToast('Kopyalandı');
}

function renderItem(item) {
  const who = item.mine ? 'Bu cihaz' : item.from.name;
  const meta = el('div', { className: 'meta' });
  let body;
  let action;

  if (item.type === 'text') {
    body = el('pre', { textContent: item.text.length > 600 ? `${item.text.slice(0, 600)}…` : item.text });
    meta.append(el('span', { textContent: `${who} · ${formatTime(item.ts)}` }));
    action = el('button', { textContent: 'Kopyala' });
    action.onclick = (e) => {
      e.stopPropagation();
      copyItem(item.id);
    };
  } else {
    body = el('div', {}, el('div', { className: 'file-name', textContent: item.name }), el('div', { className: 'bar', hidden: true }, el('i')));
    meta.append(el('span', { className: 'info' }));
    action = el('button', { textContent: 'Masaüstüne indir', disabled: !item.ready });
    action.onclick = (e) => {
      e.stopPropagation();
      api.call('download', item.id);
    };
  }
  meta.append(action);

  const li = el('li', { className: 'item', id: `item-${item.id}`, title: item.type === 'text' ? 'Tıkla: kopyala · Sağ tık: seçenekler' : 'Sağ tık: seçenekler' }, body, meta);
  li.onclick = () => (item.type === 'text' ? copyItem(item.id) : api.call('menu', item.id));
  li.oncontextmenu = (e) => {
    e.preventDefault();
    api.call('menu', item.id);
  };
  if (item.type === 'file') paintFile(li, item);
  return li;
}

// Dosya satırının durum yazısını ve ilerleme çubuğunu günceller (liste yeniden çizilmeden).
function paintFile(li, item) {
  const t = transfers[item.id];
  const who = item.mine ? 'Bu cihaz' : item.from.name;
  let text = `${formatSize(item.size)} · ${who} · ${formatTime(item.ts)}`;
  if (t && t.total > 0) {
    const pct = Math.min(100, Math.floor((t.done / t.total) * 100));
    text = `${t.dir === 'in' ? 'İndiriliyor' : 'Gönderiliyor'} %${pct} · ${formatSize(item.size)}`;
    li.querySelector('.bar i').style.width = `${pct}%`;
  } else if (!item.ready) {
    text = `Gönderen cihaz bekleniyor · ${formatSize(item.size)}`;
  }
  li.querySelector('.bar').hidden = !t;
  li.querySelector('.info').textContent = text;
}

function paintTransfers() {
  if (!state) return;
  for (const item of state.items) {
    const li = item.type === 'file' && document.getElementById(`item-${item.id}`);
    if (li) paintFile(li, item);
  }
}

function renderPlainList(target, entries, emptyText, onRemove) {
  target.replaceChildren(
    ...(entries.length
      ? entries.map((entry) => {
          const li = el('li', {}, el('span', { textContent: entry.label }));
          if (onRemove) {
            const remove = el('button', { textContent: 'Kaldır' });
            remove.onclick = () => onRemove(entry.value);
            li.append(remove);
          }
          return li;
        })
      : [el('li', { className: 'none', textContent: emptyText })])
  );
}

function render() {
  if (!state) return;
  const { items, peers, device, manualPeers, pinned, isMac } = state;
  transfers = state.transfers || {};

  $('status').classList.toggle('online', peers.length > 0);
  $('status-text').textContent = peers.length
    ? `${peers.map((p) => p.name).join(', ')} bağlı`
    : 'Diğer cihaz aranıyor…';
  $('pin').classList.toggle('active', pinned);
  $('send-hint').textContent = isMac ? '⌘↵' : 'Ctrl+Enter';

  $('list').replaceChildren(...items.map(renderItem));
  $('empty').hidden = items.length > 0;
  $('list').hidden = items.length === 0;
  $('list-head').hidden = items.length === 0;
  $('list-count').textContent = `${items.length} öğe`;

  $('addresses').textContent = device.addresses.join(', ') || 'ağ bağlantısı yok';
  renderPlainList(
    $('peer-list'),
    peers.map((p) => ({ label: `${p.name} (${p.host})` })),
    'Şu an bağlı cihaz yok'
  );
  renderPlainList(
    $('manual-list'),
    manualPeers.map((p) => ({ label: p, value: p })),
    '',
    (address) => api.call('remove-manual-peer', address)
  );
}

// ---- Gönderme ----

const input = $('input');

function sendText() {
  if (!input.value.trim()) return;
  api.call('add-text', input.value);
  input.value = '';
  $('send').disabled = true;
}

async function sendFiles(fileList) {
  const paths = [];
  for (const file of fileList) {
    const filePath = api.pathFor(file);
    if (filePath) paths.push(filePath);
    // Panodan yapıştırılan görsel gibi diskte karşılığı olmayan veriler
    else await api.call('add-blob', { name: file.name || 'pano.png', data: await file.arrayBuffer() });
  }
  if (paths.length) await api.call('add-files', paths);
}

input.addEventListener('input', () => ($('send').disabled = !input.value.trim()));
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendText();
});
input.addEventListener('paste', (e) => {
  if (e.clipboardData.files.length) {
    e.preventDefault();
    sendFiles(e.clipboardData.files);
  }
});
$('send').onclick = sendText;
$('pick').onclick = () => api.call('pick-files');
$('clear-all').onclick = () => api.call('clear-all');

const composer = $('composer');
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  composer.classList.add('drag');
});
window.addEventListener('dragleave', () => composer.classList.remove('drag'));
window.addEventListener('drop', (e) => {
  e.preventDefault();
  composer.classList.remove('drag');
  if (e.dataTransfer.files.length) sendFiles(e.dataTransfer.files);
  else {
    const text = e.dataTransfer.getData('text/plain');
    if (text.trim()) api.call('add-text', text);
  }
});

// ---- Üst çubuk ve ayarlar ----

$('pin').onclick = () => api.call('set-pinned', !state.pinned);

function toggleSettings(open) {
  $('settings-view').hidden = !open;
  $('main-view').hidden = open;
  $('settings-btn').classList.toggle('active', open);
  if (open) {
    $('device-name').value = state.device.name;
    $('device-code').value = formatCode(state.device.code);
  } else {
    input.focus();
  }
}

function saveDevice() {
  api.call('set-device', { name: $('device-name').value, code: $('device-code').value });
}

$('settings-btn').onclick = () => toggleSettings($('settings-view').hidden);
$('settings-done').onclick = () => toggleSettings(false);
$('device-name').onchange = saveDevice;
$('device-code').onchange = saveDevice;
$('quit').onclick = () => api.call('quit');

function addManualPeer() {
  const field = $('manual-input');
  if (!field.value.trim()) return;
  api.call('add-manual-peer', field.value);
  field.value = '';
}
$('manual-add').onclick = addManualPeer;
$('manual-input').addEventListener('keydown', (e) => e.key === 'Enter' && addManualPeer());

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('settings-view').hidden) toggleSettings(false);
  else api.call('hide');
});

// ---- Ana süreçten gelen olaylar ----

api.on('state', (next) => {
  state = next;
  render();
});
api.on('toast', showToast);
api.on('progress', (next) => {
  transfers = next;
  paintTransfers();
});
api.on('shown', () => {
  render(); // "5 dk önce" gibi süreleri tazele
  if ($('settings-view').hidden) input.focus();
});

api.call('state').then((initial) => {
  state = initial;
  render();
});
