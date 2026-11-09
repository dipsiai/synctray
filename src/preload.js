const { contextBridge, ipcRenderer, webUtils } = require('electron');

const CALLS = new Set([
  'state',
  'add-text',
  'add-files',
  'add-blob',
  'pick-files',
  'copy',
  'download',
  'menu',
  'clear-all',
  'set-device',
  'add-manual-peer',
  'remove-manual-peer',
  'set-pinned',
  'hide',
  'quit',
]);

contextBridge.exposeInMainWorld('api', {
  call(channel, ...args) {
    if (!CALLS.has(channel)) throw new Error(`bilinmeyen çağrı: ${channel}`);
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel, handler) {
    if (!['state', 'toast', 'shown', 'progress'].includes(channel)) return;
    ipcRenderer.on(channel, (_event, data) => handler(data));
  },
  // Sürüklenen/yapıştırılan dosyanın diskteki yolu (panodaki görseller için boş döner).
  pathFor: (file) => webUtils.getPathForFile(file),
});
