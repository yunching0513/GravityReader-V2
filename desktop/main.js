// GravityReader · Electron main process
// Spawns the bundled Python (FastAPI) backend once, then serves one or more
// independent app windows (great for dual-monitor: a paper per screen). The
// backend is terminated when the app quits.

const { app, BrowserWindow, shell, ipcMain, Menu, screen } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');

// Reveal a generated file (e.g. an exported audiobook) in Finder.
ipcMain.handle('gr:reveal', (_e, p) => {
    if (typeof p === 'string' && p) {
        try { shell.showItemInFolder(p); } catch (_) { /* ignore */ }
    }
});

const BACKEND_PORT = Number(process.env.GR_PORT || 8000);
const BACKEND_HOST = '127.0.0.1';

let backendProc = null;
let backendReady = false;

// ── backend ───────────────────────────────────────────────────────────
function backendExePath() {
    const base = app.isPackaged ? process.resourcesPath : __dirname;
    const exe = process.platform === 'win32' ? 'GravityReaderBackend.exe' : 'GravityReaderBackend';
    return path.join(base, 'backend', 'GravityReaderBackend', exe);
}

function rendererIndex() { return path.join(__dirname, 'renderer', 'index.html'); }
function loadingPath() { return path.join(__dirname, 'loading.html'); }

function startBackend() {
    const exe = backendExePath();
    backendProc = spawn(exe, [], {
        cwd: path.dirname(exe),
        env: { ...process.env, GR_HOST: BACKEND_HOST, GR_PORT: String(BACKEND_PORT) },
        stdio: 'inherit',
    });
    backendProc.on('error', (err) => console.error('[backend] failed to start:', err));
    backendProc.on('exit', (code, signal) => {
        console.log(`[backend] exited (code=${code}, signal=${signal})`);
        backendProc = null;
    });
}

function stopBackend() {
    if (backendProc && !backendProc.killed) {
        try { backendProc.kill('SIGTERM'); } catch (_) { /* ignore */ }
        backendProc = null;
    }
}

function waitForBackend(timeoutMs = 90000) {
    const start = Date.now();
    return new Promise((resolve) => {
        const attempt = () => {
            const req = http.get(
                { host: BACKEND_HOST, port: BACKEND_PORT, path: '/', timeout: 2000 },
                (res) => { res.resume(); resolve(true); }
            );
            req.on('error', retry);
            req.on('timeout', () => { req.destroy(); retry(); });
        };
        const retry = () => {
            if (Date.now() - start > timeoutMs) return resolve(false);
            setTimeout(attempt, 500);
        };
        attempt();
    });
}

// ── window-bounds persistence (remember screen + size) ─────────────────
function stateFile() { return path.join(app.getPath('userData'), 'window-state.json'); }

function loadBounds() {
    try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch (_) { return null; }
}

function saveBounds(win) {
    try {
        if (!win || win.isDestroyed() || win.isFullScreen() || win.isMinimized()) return;
        fs.writeFileSync(stateFile(), JSON.stringify(win.getBounds()));
    } catch (_) { /* ignore */ }
}

// True if the saved rectangle still overlaps a connected display (so we don't
// restore onto an unplugged external monitor).
function boundsVisible(b) {
    if (!b) return false;
    return screen.getAllDisplays().some((d) => {
        const wa = d.workArea;
        return b.x < wa.x + wa.width && b.x + b.width > wa.x &&
               b.y < wa.y + wa.height && b.y + b.height > wa.y;
    });
}

function loadRenderer(win) {
    const devUrl = process.env.GR_DEV_URL;
    if (devUrl) win.loadURL(devUrl); else win.loadFile(rendererIndex());
}

function createWindow() {
    const saved = loadBounds();
    const opts = {
        width: 1320,
        height: 880,
        minWidth: 920,
        minHeight: 600,
        backgroundColor: '#F1EFE9',
        title: "Yun's Reader",
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    };
    if (saved && boundsVisible(saved)) {
        opts.width = saved.width;
        opts.height = saved.height;
        // Cascade additional windows so they don't land exactly on top.
        const offset = BrowserWindow.getAllWindows().length * 32;
        opts.x = saved.x + offset;
        opts.y = saved.y + offset;
    }
    const win = new BrowserWindow(opts);
    win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
    win.on('close', () => saveBounds(win));
    return win;
}

// Open an independent app window (reuses the running backend).
async function openWindow() {
    const win = createWindow();
    if (backendReady) { loadRenderer(win); return win; }

    win.loadFile(loadingPath());
    if (!backendProc) startBackend();
    const ready = await waitForBackend();
    if (win.isDestroyed()) return win;
    if (ready) { backendReady = true; loadRenderer(win); }
    else win.loadFile(loadingPath(), { hash: 'error' });
    return win;
}

// ── dual-monitor: move the focused window to the next display ───────────
function moveToOtherDisplay(win) {
    if (!win) return;
    const displays = screen.getAllDisplays();
    if (displays.length < 2) return;
    const cur = screen.getDisplayMatching(win.getBounds());
    const idx = displays.findIndex((d) => d.id === cur.id);
    const next = displays[(idx + 1) % displays.length];
    const wa = next.workArea;
    const b = win.getBounds();
    const w = Math.min(b.width, wa.width);
    const h = Math.min(b.height, wa.height);
    if (win.isFullScreen()) win.setFullScreen(false);
    win.setBounds({
        x: Math.round(wa.x + (wa.width - w) / 2),
        y: Math.round(wa.y + (wa.height - h) / 2),
        width: w, height: h,
    });
}

// ── application menu ───────────────────────────────────────────────────
function buildMenu() {
    const isMac = process.platform === 'darwin';
    const template = [
        ...(isMac ? [{ role: 'appMenu' }] : []),
        {
            label: 'File',
            submenu: [
                { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => openWindow() },
                { type: 'separator' },
                isMac ? { role: 'close' } : { role: 'quit' },
            ],
        },
        { role: 'editMenu' },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                {
                    label: 'Move to Other Display',
                    accelerator: 'CmdOrCtrl+Alt+Right',
                    click: (_item, win) => moveToOtherDisplay(win),
                },
                { role: 'togglefullscreen' },
            ],
        },
        { role: 'windowMenu' },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── lifecycle ──────────────────────────────────────────────────────────
app.whenReady().then(() => {
    buildMenu();
    openWindow();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', stopBackend);
process.on('exit', stopBackend);
