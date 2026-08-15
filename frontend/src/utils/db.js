const DB_NAME = 'GravityReaderDB';
const STORE_NAME = 'files';
const NOTES_STORE = 'notes';
const AUDIO_STORE = 'audio';
const TRANSLATION_STORE = 'translations';
const SESSIONS_STORE = 'sessions';
const DUMPS_STORE = 'dumps';
const ASSETS_STORE = 'assets';
const DB_VERSION = 5;

// Set when another window upgrades the schema under us. Once this is true every
// further open() with our (now older) version would fail with VersionError, so
// callers should stop and ask the user to reload rather than retry forever.
let staleSchema = false;
export const isSchemaStale = () => staleSchema;

// Opening IndexedDB is not free, and every helper below used to do it. Hold the
// one connection open for the session instead (re-opening on the rare version
// change / close event), so a page of read-aloud lookups is dozens of cheap
// transactions rather than dozens of database opens.
let dbPromise = null;

export const initDB = () => {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = (event) => {
            dbPromise = null;
            reject("IndexedDB error: " + event.target.error);
        };

        request.onsuccess = (event) => {
            const db = event.target.result;
            // Drop the cached handle if the connection goes away (another tab
            // upgrading the schema, or the browser evicting storage).
            db.onclose = () => { dbPromise = null; };
            // Another window opened a newer schema. Our connection must close,
            // and re-opening at our old version would throw VersionError — so
            // flag it and let the UI ask for a reload instead.
            db.onversionchange = () => {
                staleSchema = true;
                dbPromise = null;
                db.close();
            };
            resolve(db);
        };

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
            }
            // v2: per-document notes, queryable by the file they belong to.
            if (!db.objectStoreNames.contains(NOTES_STORE)) {
                const notes = db.createObjectStore(NOTES_STORE, { keyPath: 'id', autoIncrement: true });
                notes.createIndex('fileId', 'fileId', { unique: false });
            }
            // v3: cached TTS audio clips, keyed by a content hash (key) and the
            // owning file so we never regenerate (or re-bill) the same sentence.
            if (!db.objectStoreNames.contains(AUDIO_STORE)) {
                const audio = db.createObjectStore(AUDIO_STORE, { keyPath: 'key' });
                audio.createIndex('fileId', 'fileId', { unique: false });
            }
            // v4: cached translations, keyed by mode + text hash. Re-selecting a
            // passage you already read back is then instant and free.
            if (!db.objectStoreNames.contains(TRANSLATION_STORE)) {
                db.createObjectStore(TRANSLATION_STORE, { keyPath: 'key' });
            }
            // v5: focus-session history, thought dumps, and local ambience audio.
            if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
                const sessions = db.createObjectStore(SESSIONS_STORE, { keyPath: 'id' });
                sessions.createIndex('startedAt', 'startedAt', { unique: false });
                sessions.createIndex('fileId', 'fileId', { unique: false });
            }
            if (!db.objectStoreNames.contains(DUMPS_STORE)) {
                const dumps = db.createObjectStore(DUMPS_STORE, { keyPath: 'id', autoIncrement: true });
                dumps.createIndex('createdAt', 'createdAt', { unique: false });
                dumps.createIndex('fileId', 'fileId', { unique: false });
            }
            if (!db.objectStoreNames.contains(ASSETS_STORE)) {
                db.createObjectStore(ASSETS_STORE, { keyPath: 'key' });
            }
        };
    });
    return dbPromise;
};

export const saveFile = async (file) => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);

        const fileData = {
            name: file.name,
            type: file.type,
            data: file,
            timestamp: new Date().getTime()
        };

        const request = store.add(fileData);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
};

export const getFiles = async () => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
};

export const deleteFile = async (id) => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.delete(id);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
};

export const updateFilePage = async (id, page) => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const getRequest = store.get(id);

        getRequest.onsuccess = () => {
            const data = getRequest.result;
            if (data) {
                data.lastPage = page;
                data.timestamp = new Date().getTime(); // Update timestamp to show as recently accessed
                const updateRequest = store.put(data);
                updateRequest.onsuccess = () => resolve();
                updateRequest.onerror = () => reject(updateRequest.error);
            } else {
                reject("File not found");
            }
        };
        getRequest.onerror = () => reject(getRequest.error);
    });
};

// ── Notes ─────────────────────────────────────────────────────────────
// A note belongs to a file (fileId). It may be a free-form thought, or a
// passage captured from the bilingual reading (en/zh). source: 'manual' | 'reading'.

export const addNote = async ({ fileId, text = '', en = '', zh = '', source = 'manual' }) => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([NOTES_STORE], 'readwrite');
        const store = transaction.objectStore(NOTES_STORE);
        const note = { fileId, text, en, zh, source, createdAt: new Date().getTime() };
        const request = store.add(note);
        request.onsuccess = () => resolve({ ...note, id: request.result });
        request.onerror = () => reject(request.error);
    });
};

export const getNotes = async (fileId) => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([NOTES_STORE], 'readonly');
        const store = transaction.objectStore(NOTES_STORE);
        const index = store.index('fileId');
        const request = index.getAll(fileId);
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
    });
};

export const updateNote = async (id, text) => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([NOTES_STORE], 'readwrite');
        const store = transaction.objectStore(NOTES_STORE);
        const getRequest = store.get(id);
        getRequest.onsuccess = () => {
            const data = getRequest.result;
            if (data) {
                data.text = text;
                const updateRequest = store.put(data);
                updateRequest.onsuccess = () => resolve();
                updateRequest.onerror = () => reject(updateRequest.error);
            } else {
                reject("Note not found");
            }
        };
        getRequest.onerror = () => reject(getRequest.error);
    });
};

export const deleteNote = async (id) => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([NOTES_STORE], 'readwrite');
        const store = transaction.objectStore(NOTES_STORE);
        const request = store.delete(id);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
};

// ── Audio cache (TTS) ─────────────────────────────────────────────────

export const getAudio = async (key) => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([AUDIO_STORE], 'readonly');
        const request = transaction.objectStore(AUDIO_STORE).get(key);
        request.onsuccess = () => resolve(request.result ? request.result.blob : null);
        request.onerror = () => reject(request.error);
    });
};

export const putAudio = async (key, fileId, blob) => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([AUDIO_STORE], 'readwrite');
        const request = transaction.objectStore(AUDIO_STORE).put({ key, fileId, blob, createdAt: new Date().getTime() });
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
};

// ── Translation cache ─────────────────────────────────────────────────
// Selecting the same passage twice (or re-opening a paper you worked through
// last week) should not cost another Gemini call or another wait.

export const getTranslation = async (key) => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([TRANSLATION_STORE], 'readonly');
        const request = transaction.objectStore(TRANSLATION_STORE).get(key);
        request.onsuccess = () => resolve(request.result ? request.result.result : null);
        request.onerror = () => reject(request.error);
    });
};

export const putTranslation = async (key, result) => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([TRANSLATION_STORE], 'readwrite');
        const request = transaction.objectStore(TRANSLATION_STORE).put({ key, result, createdAt: new Date().getTime() });
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
};

// ── Focus sessions ────────────────────────────────────────────────────
// One record per focus block, completed or abandoned. Time-series data that
// nobody needs at first paint — which is exactly why it lives here and the
// live timer state lives in settings.js instead.

export const addSession = async (session) => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([SESSIONS_STORE], 'readwrite');
        const request = transaction.objectStore(SESSIONS_STORE).put(session);
        request.onsuccess = () => resolve(session);
        request.onerror = () => reject(request.error);
    });
};

export const listSessions = async (sinceTs = 0) => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([SESSIONS_STORE], 'readonly');
        const index = transaction.objectStore(SESSIONS_STORE).index('startedAt');
        const request = index.getAll(IDBKeyRange.lowerBound(sinceTs));
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
    });
};

// ── Thought dumps (思緒卸載盒) ─────────────────────────────────────────

export const addDump = async ({ fileId = null, text = '', nextStep = '', kind = 'open' }) => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([DUMPS_STORE], 'readwrite');
        const dump = { fileId, text, nextStep, kind, createdAt: new Date().getTime() };
        const request = transaction.objectStore(DUMPS_STORE).add(dump);
        request.onsuccess = () => resolve({ ...dump, id: request.result });
        request.onerror = () => reject(request.error);
    });
};

export const getDumps = async (fileId) => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([DUMPS_STORE], 'readonly');
        const store = transaction.objectStore(DUMPS_STORE);
        const request = fileId == null
            ? store.getAll()
            : store.index('fileId').getAll(fileId);
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
    });
};

export const deleteDump = async (id) => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([DUMPS_STORE], 'readwrite');
        const request = transaction.objectStore(DUMPS_STORE).delete(id);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
};

// ── Local assets (user-supplied ambience audio) ───────────────────────

export const putAsset = async (key, blob, meta = {}) => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([ASSETS_STORE], 'readwrite');
        const request = transaction.objectStore(ASSETS_STORE)
            .put({ key, blob, ...meta, createdAt: new Date().getTime() });
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
};

export const getAsset = async (key) => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([ASSETS_STORE], 'readonly');
        const request = transaction.objectStore(ASSETS_STORE).get(key);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
    });
};
