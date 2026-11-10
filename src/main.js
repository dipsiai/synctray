const { app, BrowserWindow, Tray, Menu, ipcMain, clipboard, nativeImage, screen, dialog, Notification, globalShortcut } = require('electron');
const { fileURLToPath } = require('url');
const qrcode = require('qrcode-generator');
const path = require('path');
const fs = require('fs');
const { Store } = require('./store');
const { Net, HTTP_PORT } = require('./net');
const { STRINGS, pickLanguage, translator } = require('./i18n');

const isMac = process.platform === 'darwin';
const WIDTH = 380;
const HEIGHT = 560;
// Work from any app. Changeable in Settings; an empty value turns one off.
const DEFAULT_SHORTCUTS = { open: 'Alt+Shift+V', send: 'Alt+Shift+C' };

// SYNC_PROFILE=second npm start → runs a second "device" on the same machine (for testing).
const profile = process.env.SYNC_PROFILE;
if (profile) app.setPath('userData', `${app.getPath('userData')}-${profile}`);
const primary = profile ? true : app.requestSingleInstanceLock();

let store;
let net;
let tray;
let win;
let lastHide = 0;
let dialogOpen = false;
let lang = 'en';
let t = translator(lang);

if (!primary) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(init);
  app.on('window-all-closed', () => {}); // keep living in the tray
}

async function init() {
  if (isMac) app.dock.hide();
  // SYNC_LANG=en|tr forces a language; otherwise it follows the operating system.
  lang = process.env.SYNC_LANG || pickLanguage(app.getLocale());
  t = translator(lang);

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
  if (!store.state.asleep) await net.start();
  paintTray();
  registerShortcuts();
  app.on('will-quit', () => globalShortcut.unregisterAll());
  pushState();
}

const shortcuts = () => ({ ...DEFAULT_SHORTCUTS, ...store.state.shortcuts });

// Returns the accelerators that could not be registered (taken by another app, or invalid).
function registerShortcuts() {
  const actions = {
    open: () => (win.isVisible() ? hideWindow() : showWindow()),
    send: sendClipboard,
  };
  globalShortcut.unregisterAll();
  const failed = [];
  for (const [name, accelerator] of Object.entries(shortcuts())) {
    if (!accelerator || !actions[name]) continue;
    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, actions[name]);
    } catch {
      ok = false;
    }
    if (!ok) failed.push(accelerator);
  }
  return failed;
}

// Files copied in Finder/Explorer, as paths. Empty when the clipboard holds something else.
function clipboardFiles() {
  try {
    if (isMac) {
      const url = clipboard.read('public.file-url');
      return url ? [fileURLToPath(url)] : [];
    }
    const raw = clipboard.readBuffer('FileNameW');
    const name = raw.toString('ucs2').replace(/\0+$/, '');
    return name ? [name] : [];
  } catch {
    return [];
  }
}

// The window is usually hidden when a shortcut fires, so confirm with a quiet notification.
function announce(message) {
  if (win.isVisible()) return toast(message);
  if (Notification.isSupported()) new Notification({ title: 'SyncTray', body: message, silent: true }).show();
}

// Sleep mode: the network is fully off (no broadcasts, no open port, no timers) until woken.
// Remembered across restarts. Toggles are queued so a quick double click cannot overlap.
let sleepQueue = Promise.resolve();
function setAsleep(asleep) {
  asleep = Boolean(asleep);
  store.set({ asleep });
  paintTray();
  sleepQueue = sleepQueue
    .then(() => (store.state.asleep ? net.sleep() : net.wake()))
    .catch(() => {})
    .then(pushState);
  return sleepQueue;
}

const paintTray = () => tray.setToolTip(store.state.asleep ? `SyncTray (${t('asleep')})` : 'SyncTray');
const sentText = () => t(store.state.asleep ? 'sentLater' : 'sent');

async function sendClipboard() {
  const files = clipboardFiles().filter((p) => fs.existsSync(p));
  if (files.length) {
    await addFiles(files);
    return announce(sentText());
  }
  const text = clipboard.readText();
  if (text.trim()) {
    await addText(text);
    return announce(sentText());
  }
  const image = clipboard.readImage();
  if (!image.isEmpty()) {
    net.publish(await store.addBuffer('clipboard.png', image.toPNG()));
    return announce(sentText());
  }
  announce(t('clipboardEmpty'));
}

// QR code for the phone page, as rows of booleans for the window to draw.
function webLink() {
  const url = net.webLink();
  if (!url) return null;
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  const size = qr.getModuleCount();
  return Array.from({ length: size }, (_r, row) => Array.from({ length: size }, (_c, col) => qr.isDark(row, col)));
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
      dialogOpen = true; // don't hide on focus loss
      showWindow();
      await new Promise((r) => setTimeout(r, Number(process.env.SYNC_DEBUG_DELAY) || 1500));
      // Development only: drive the window before the screenshot, e.g. to open Settings.
      if (process.env.SYNC_DEBUG_EVAL) {
        await win.webContents.executeJavaScript(process.env.SYNC_DEBUG_EVAL);
        await new Promise((r) => setTimeout(r, 800));
      }
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
    // Clicking the icon while the window is open first hides it via blur; ignore the click that follows.
    if (win.isVisible()) hideWindow();
    else if (Date.now() - lastHide > 250) showWindow();
  });
  tray.on('right-click', () => tray.popUpContextMenu(trayMenu()));
  // macOS: drop a file straight onto the menu bar icon.
  tray.on('drop-files', (_event, files) => addFiles(files));
}

function trayMenu() {
  const { openAtLogin } = app.getLoginItemSettings();
  return Menu.buildFromTemplate([
    { label: t('trayOpen'), click: showWindow },
    {
      label: t('traySendClipboard'),
      accelerator: shortcuts().send || undefined,
      click: sendClipboard,
    },
    {
      label: t('traySleep'),
      type: 'checkbox',
      checked: Boolean(store.state.asleep),
      click: (item) => setAsleep(item.checked),
    },
    { type: 'separator' },
    {
      label: t('trayAutostart'),
      type: 'checkbox',
      checked: openAtLogin,
      enabled: app.isPackaged,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: t('trayQuit'), click: quit },
  ]);
}

function showWindow() {
  const icon = tray.getBounds();
  const area = screen.getDisplayMatching(icon).workArea;
  const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
  const x = clamp(Math.round(icon.x + icon.width / 2 - WIDTH / 2), area.x + 8, area.x + area.width - WIDTH - 8);
  // Tray at the top (macOS): open below it. Tray at the bottom (Windows): open above it.
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
    asleep: Boolean(store.state.asleep),
    transfers: net.transferState(),
    shortcuts: shortcuts(),
    isMac,
  };
}

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

const pushState = () => send('state', getState());
const toast = (message) => send('toast', message);

// Avoid a burst of notifications when many items arrive: at most one every few seconds.
let lastNote = 0;
function notifyIncoming(items) {
  if (win.isVisible() || !Notification.isSupported() || Date.now() - lastNote < 4000) return;
  lastNote = Date.now();
  const [item] = items;
  const single = items.length === 1;
  const note = new Notification({
    title: single
      ? t(item.type === 'text' ? 'noteText' : 'noteFile', { name: item.from.name })
      : t('noteMany', { name: item.from.name, count: items.length }),
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
    toast(item.type === 'file' ? t('sentAsFile') : sentText());
  } catch (err) {
    toast(t('sendFailed', { error: err.message }));
  }
}

const BIG_FILE = 200 * 1024 * 1024;

async function addFiles(paths) {
  for (const p of paths) {
    try {
      const { size } = await fs.promises.stat(p);
      if (size > BIG_FILE) toast(t('preparing', { name: path.basename(p) }));
      net.publish(await store.addFile(p));
    } catch (err) {
      toast(`${path.basename(p)}: ${err.code === 'IS_DIRECTORY' ? t('noFolders') : err.message}`);
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

// File types that can run code when double-clicked: ask before saving them.
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
      message: t('riskyTitle', { name: item.name, ext }),
      detail: t('riskyDetail', { from: item.from.name }),
      buttons: [t('cancel'), t('saveAnyway')],
      defaultId: 0,
      cancelId: 0,
    })
  );
  return response === 1;
}

async function saveFile(id, target) {
  const item = store.get(id);
  if (!item || item.type !== 'file') return;
  if (!store.hasFile(id)) return toast(t('notReady'));
  if (!(await confirmRisky(item, target))) return;
  try {
    await fs.promises.copyFile(store.filePath(id), target);
    toast(t('saved', { name: path.basename(target) }));
  } catch (err) {
    toast(t('saveFailed', { error: err.message }));
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

// A system dialog takes focus away from the window; don't hide while one is open.
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
      message: t('clearTitle', { count }),
      detail: t('clearDetail'),
      buttons: [t('cancel'), t('clearConfirm')],
      defaultId: 0,
      cancelId: 0,
    })
  );
  if (response !== 1) return;
  const ts = Date.now();
  const ids = store.clear(ts);
  net.publishDelete(ids, ts);
  toast(t('cleared'));
}

function itemMenu(id) {
  const item = store.get(id);
  if (!item) return;
  const template =
    item.type === 'file'
      ? [
          { label: t('saveToDesktop'), click: () => downloadToDesktop(id) },
          { label: t('saveAs'), click: () => saveAs(id) },
        ]
      : [
          {
            label: t('copy'),
            click: () => {
              if (copyText(id)) toast(t('copied'));
            },
          },
        ];
  template.push({ type: 'separator' }, { label: t('deleteEverywhere'), click: () => removeItem(id) });
  Menu.buildFromTemplate(template).popup({ window: win });
}

function registerIpc() {
  const handlers = {
    state: () => getState(),
    strings: () => ({ lang, strings: STRINGS[lang] || STRINGS.en }),
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
    'web-link': () => webLink(),
    'set-shortcut': ({ name, accelerator }) => {
      if (!(name in DEFAULT_SHORTCUTS)) return;
      store.set({ shortcuts: { ...shortcuts(), [name]: String(accelerator || '') } });
      const failed = registerShortcuts();
      if (failed.length) toast(t('shortcutTaken', { keys: failed.join(', ') }));
    },
    'set-device': ({ name, code }) => {
      const before = store.state.code;
      store.set({ deviceName: name, code });
      if (store.state.code !== before) net.reset();
      else net.beacon();
    },
    'add-manual-peer': (address) => {
      const clean = String(address).trim();
      if (!/^[\w.-]+(:\d{1,5})?$/.test(clean)) return toast(t('badAddress'));
      if (!store.state.manualPeers.includes(clean)) store.set({ manualPeers: [...store.state.manualPeers, clean] });
      net.tick();
    },
    'remove-manual-peer': (address) => {
      store.set({ manualPeers: store.state.manualPeers.filter((p) => p !== address) });
    },
    'set-asleep': (asleep) => setAsleep(asleep),
    'set-pinned': (pinned) => store.set({ pinned: Boolean(pinned) }),
    hide: () => hideWindow(),
    quit: () => quit(),
  };
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_event, arg) => handler(arg));
  }
}
