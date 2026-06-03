// GravityReader · Electron main process
// Spawns the bundled Python (FastAPI) backend, waits for it to come up, then
// loads the built React UI. The backend is terminated when the app quits.

const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
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
let mainWindow = null;

// Resolve the bundled backend executable. In a packaged app it lives under
// the app's Resources; during `npm start` it sits next to this file.
function backendExePath() {
    const base = app.isPackaged ? process.resourcesPath : __dirname;
    return path.join(base, 'backend', 'GravityReaderBackend', 'GravityReaderBackend');
}

function rendererIndex() {
    return path.join(__dirname, 'renderer', 'index.html');
}

function startBackend() {
    const exe = backendExePath();
    backendProc = spawn(exe, [], {
        cwd: path.dirname(exe),
        env: { ...process.env, GR_HOST: BACKEND_HOST, GR_PORT: String(BACKEND_PORT) },
        stdio: 'inherit',
    });
    backendProc.on('error', (err) => {
        console.error('[backend] failed to start:', err);
    });
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

// Poll GET / until the backend answers, or the timeout elapses.
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

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1320,
        height: 880,
        minWidth: 920,
        minHeight: 600,
        backgroundColor: '#F1EFE9',
        title: 'GravityReader',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    // Open external links (Google Fonts, unpkg pdf worker are loaded as
    // resources, not navigations) in the system browser rather than in-app.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.on('closed', () => { mainWindow = null; });
    return mainWindow;
}

async function boot() {
    const win = createWindow();

    // Show the concrete loading screen while the backend warms up.
    win.loadFile(path.join(__dirname, 'loading.html'));

    startBackend();
    const ready = await waitForBackend();

    if (!win || win.isDestroyed()) return;

    if (ready) {
        const devUrl = process.env.GR_DEV_URL;
        if (devUrl) {
            win.loadURL(devUrl);
        } else {
            win.loadFile(rendererIndex());
        }
    } else {
        win.loadFile(path.join(__dirname, 'loading.html'), { hash: 'error' });
    }
}

app.whenReady().then(boot);

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) boot();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', stopBackend);
process.on('exit', stopBackend);
