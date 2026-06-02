const DB_NAME = 'GravityReaderDB';
const STORE_NAME = 'files';
const NOTES_STORE = 'notes';
const DB_VERSION = 2;

export const initDB = () => {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = (event) => reject("IndexedDB error: " + event.target.error);

        request.onsuccess = (event) => resolve(event.target.result);

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
        };
    });
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
