const { app, BrowserWindow, Tray, Menu, ipcMain, clipboard, nativeImage, screen, dialog, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { Store } = require('./store');
const { Net, HTTP_PORT } = require('./net');

const isMac = process.platform === 'darwin';
const WIDTH = 380;
const HEIGHT = 560;

// SYNC_PROFILE=ikinci npm start → aynı makinede ikinci bir "cihaz" açar (deneme için).
const profile = process.env.SYNC_PROFILE;
if (profile) app.setPath('userData', `${app.getPath('userData')}-${profile}`);
const primary = profile ? true : app.requestSingleInstanceLock();

let store;
let net;
let tray;
let win;
let lastHide = 0;
let dialogOpen = false;

if (!primary) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(init);
  app.on('window-all-closed', () => {}); // tepside yaşamaya devam et
}

async function init() {
  if (isMac) app.dock.hide();

  store = new Store(app.getPath('userData'));
  net = new Net(store);

  createWindow();
  createTray();
  registerIpc();

  store.on('change', pushState);
  net.on('peers', pushState);
  net.on('incoming', notifyIncoming);
  net.on('progress', () => send('progress', net.transferState()));
  setInterval(() => store.expire(), 3600 * 1000);
  await net.start();
  pushState();
}

function createWindow() {
  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  if (isMac) win.setVisibleOnAllWorkspaces(true);

  win.on('blur', () => {
    if (!store.state.pinned && !dialogOpen) hideWindow();
  });
  win.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      hideWindow();
    }
  });

  const shot = process.env.SYNC_DEBUG_SHOT;
  if (shot) {
    win.webContents.once('did-finish-load', async () => {
      dialogOpen = true; // odak kaybında gizlenmesin
      showWindow();
      await new Promise((r) => setTimeout(r, Number(process.env.SYNC_DEBUG_DELAY) || 1500));
      fs.writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
      dialogOpen = false;
    });
  }
}

function createTray() {
  const file = isMac ? 'trayTemplate.png' : 'tray.png';
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, '..', 'assets', file)));
  tray.setToolTip('SyncTray');

  tray.on('click', () => {
    // Pencere açıkken ikona basmak önce blur ile gizler; hemen ardından gelen tıklama tekrar açmasın.
    if (win.isVisible()) hideWindow();
    else if (Date.now() - lastHide > 250) showWindow();
  });
  tray.on('right-click', () => tray.popUpContextMenu(trayMenu()));
  // macOS: dosyayı doğrudan menü çubuğundaki ikona bırak.
  tray.on('drop-files', (_event, files) => addFiles(files));
}

function trayMenu() {
  const { openAtLogin } = app.getLoginItemSettings();
  return Menu.buildFromTemplate([
    { label: 'SyncTray\'i aç', click: showWindow },
    {
      label: 'Panodaki metni gönder',
      click: () => addText(clipboard.readText()),
    },
    { type: 'separator' },
    {
      label: 'Bilgisayar açılınca başlat',
      type: 'checkbox',
      checked: openAtLogin,
      enabled: app.isPackaged,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: 'Çıkış', click: quit },
  ]);
}

function showWindow() {
  const icon = tray.getBounds();
  const area = screen.getDisplayMatching(icon).workArea;
  const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
  const x = clamp(Math.round(icon.x + icon.width / 2 - WIDTH / 2), area.x + 8, area.x + area.width - WIDTH - 8);
  // Tepsi üstteyse (macOS) pencere altına, alttaysa (Windows) üstüne açılır.
  const below = icon.y < area.y + area.height / 2;
  const y = below ? icon.y + icon.height + 6 : icon.y - HEIGHT - 6;
  win.setPosition(x, clamp(y, area.y + 8, area.y + area.height - HEIGHT - 8), false);
  win.show();
  win.focus();
  win.webContents.send('shown');
}

function hideWindow() {
  if (!win.isVisible()) return;
  lastHide = Date.now();
  win.hide();
}

function quit() {
  app.isQuitting = true;
  net.stop();
  app.quit();
}

function getState() {
  return {
    items: store.list(),
    peers: net.peerList(),
    device: {
      name: store.state.deviceName,
      code: store.state.code,
      addresses: net.localIPs().map((i) => (net.port === HTTP_PORT ? i.address : `${i.address}:${net.port}`)),
    },
    manualPeers: store.state.manualPeers,
    pinned: store.state.pinned,
    transfers: net.transferState(),
    isMac,
  };
}

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

const pushState = () => send('state', getState());
const toast = (message) => send('toast', message);

// Art arda gelenlerde bildirim yağmuru olmasın: birkaç saniyede en fazla bir bildirim.
let lastNote = 0;
function notifyIncoming(items) {
  if (win.isVisible() || !Notification.isSupported() || Date.now() - lastNote < 4000) return;
  lastNote = Date.now();
  const [item] = items;
  const single = items.length === 1;
  const note = new Notification({
    title: single
      ? `${item.from.name} bir ${item.type === 'text' ? 'metin' : 'dosya'} gönderdi`
      : `${item.from.name} ${items.length} öğe gönderdi`,
    body: single ? (item.type === 'text' ? item.text.trim().slice(0, 120) : item.name) : '',
  });
  note.on('click', showWindow);
  note.show();
}

async function addText(text) {
  if (typeof text !== 'string' || !text.trim()) return;
  try {
    const item = await store.addText(text);
    net.publish(item);
    toast(item.type === 'file' ? 'Metin çok uzun, dosya olarak gönderildi' : 'Gönderildi');
  } catch (err) {
    toast(`Gönderilemedi: ${err.message}`);
  }
}

const BIG_FILE = 200 * 1024 * 1024;

async function addFiles(paths) {
  for (const p of paths) {
    try {
      const { size } = await fs.promises.stat(p);
      if (size > BIG_FILE) toast(`${path.basename(p)} hazırlanıyor…`);
      net.publish(await store.addFile(p));
    } catch (err) {
      toast(`${path.basename(p)}: ${err.message}`);
    }
  }
}

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let target = path.join(dir, name);
  for (let n = 1; fs.existsSync(target); n++) target = path.join(dir, `${base} (${n})${ext}`);
  return target;
}

// Çift tıklayınca kod çalıştırabilen dosya türleri: kaydetmeden önce ayrıca onay istenir.
const RISKY_EXT = new Set(
  ('exe msi msix bat cmd com scr pif ps1 vbs vbe js jse wsf wsh hta lnk reg jar cpl dll ' +
    'app command pkg dmg sh scpt workflow docm xlsm pptm iso img').split(' ')
);

async function confirmRisky(item, target) {
  const ext = path.extname(target).slice(1).toLowerCase();
  if (!RISKY_EXT.has(ext)) return true;
  const { response } = await withDialog(() =>
    dialog.showMessageBox(win, {
      type: 'warning',
      message: `"${item.name}" çalıştırılabilir türde bir dosya (.${ext})`,
      detail: `Gönderen: ${item.from.name}. Bunu sen göndermediysen kaydetme; açıldığında bilgisayarında program çalıştırabilir.`,
      buttons: ['Vazgeç', 'Yine de kaydet'],
      defaultId: 0,
      cancelId: 0,
    })
  );
  return response === 1;
}

async function saveFile(id, target) {
  const item = store.get(id);
  if (!item || item.type !== 'file') return;
  if (!store.hasFile(id)) return toast('Dosya henüz aktarılmadı; gönderen cihaz açık olmalı');
  if (!(await confirmRisky(item, target))) return;
  try {
    await fs.promises.copyFile(store.filePath(id), target);
    toast(`Kaydedildi: ${path.basename(target)}`);
  } catch (err) {
    toast(`Kaydedilemedi: ${err.message}`);
  }
}

const downloadToDesktop = (id) => {
  const item = store.get(id);
  if (item) return saveFile(id, uniquePath(app.getPath('desktop'), item.name));
};

async function saveAs(id) {
  const item = store.get(id);
  if (!item) return;
  const result = await withDialog(() =>
    dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), item.name) })
  );
  if (!result.canceled && result.filePath) await saveFile(id, result.filePath);
}

// Sistem diyaloğu açıkken pencere odağı kaybeder; bu sırada gizlenmesin.
async function withDialog(fn) {
  dialogOpen = true;
  try {
    return await fn();
  } finally {
    dialogOpen = false;
    win.focus();
  }
}

function copyText(id) {
  const item = store.get(id);
  if (!item || item.type !== 'text') return false;
  clipboard.writeText(item.text);
  return true;
}

function removeItem(id) {
  const ts = Date.now();
  store.remove(id, ts);
  net.publishDelete(id, ts);
}

async function clearAll() {
  const count = store.state.items.length;
  if (!count) return;
  const { response } = await withDialog(() =>
    dialog.showMessageBox(win, {
      type: 'warning',
      message: `${count} öğenin tümü silinsin mi?`,
      detail: 'Metinler ve dosyalar bağlı tüm cihazlardan silinir. Masaüstüne indirdiğin dosyalara dokunulmaz. Bu işlem geri alınamaz.',
      buttons: ['Vazgeç', 'Tümünü sil'],
      defaultId: 0,
      cancelId: 0,
    })
  );
  if (response !== 1) return;
  const ts = Date.now();
  const ids = store.clear(ts);
  net.publishDelete(ids, ts);
  toast('Tümü temizlendi');
}

function itemMenu(id) {
  const item = store.get(id);
  if (!item) return;
  const template =
    item.type === 'file'
      ? [
          { label: 'Masaüstüne indir', click: () => downloadToDesktop(id) },
          { label: 'Farklı kaydet…', click: () => saveAs(id) },
        ]
      : [
          {
            label: 'Kopyala',
            click: () => {
              if (copyText(id)) toast('Kopyalandı');
            },
          },
        ];
  template.push({ type: 'separator' }, { label: 'Sil (tüm cihazlardan)', click: () => removeItem(id) });
  Menu.buildFromTemplate(template).popup({ window: win });
}

function registerIpc() {
  const handlers = {
    state: () => getState(),
    'add-text': (text) => addText(text),
    'add-files': (paths) => addFiles(paths.filter((p) => typeof p === 'string' && p)),
    'add-blob': async ({ name, data }) => net.publish(await store.addBuffer(name, Buffer.from(data))),
    'pick-files': async () => {
      const result = await withDialog(() =>
        dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] })
      );
      if (!result.canceled) await addFiles(result.filePaths);
    },
    copy: (id) => copyText(id),
    download: (id) => downloadToDesktop(id),
    menu: (id) => itemMenu(id),
    'clear-all': () => clearAll(),
    'set-device': ({ name, code }) => {
      const before = store.state.code;
      store.set({ deviceName: name, code });
      if (store.state.code !== before) net.reset();
      else net.beacon();
    },
    'add-manual-peer': (address) => {
      const clean = String(address).trim();
      if (!/^[\w.-]+(:\d{1,5})?$/.test(clean)) return toast('Geçersiz adres. Örnek: 192.168.1.25');
      if (!store.state.manualPeers.includes(clean)) store.set({ manualPeers: [...store.state.manualPeers, clean] });
      net.tick();
    },
    'remove-manual-peer': (address) => {
      store.set({ manualPeers: store.state.manualPeers.filter((p) => p !== address) });
    },
    'set-pinned': (pinned) => store.set({ pinned: Boolean(pinned) }),
    hide: () => hideWindow(),
    quit: () => quit(),
  };
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_event, arg) => handler(arg));
  }
}
