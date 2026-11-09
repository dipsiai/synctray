const { contextBridge, ipcRenderer, webUtils } = require('electron');

const CALLS = new Set([
  'state',
  'strings',
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
    if (!CALLS.has(channel)) throw new Error(`unknown call: ${channel}`);
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel, handler) {
    if (!['state', 'toast', 'shown', 'progress'].includes(channel)) return;
    ipcRenderer.on(channel, (_event, data) => handler(data));
  },
  // Path on disk of a dropped/pasted file (empty for clipboard images).
  pathFor: (file) => webUtils.getPathForFile(file),
});
