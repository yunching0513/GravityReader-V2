// Minimal, safe bridge. The renderer only needs a couple of native niceties
// (reveal a generated audiobook in Finder); everything else stays sandboxed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gr', {
    reveal: (path) => ipcRenderer.invoke('gr:reveal', path),
});
