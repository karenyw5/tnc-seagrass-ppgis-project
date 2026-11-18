/* On-device storage in the browser's IndexedDB.

   "participants" holds one document per participant (answers + map). The four
   export tables (same columns as the Streamlit SQLite database) are derived from
   these documents in export.js. "meta" holds device settings such as the
   device name and the time of the last export. */

const DB_NAME = "seagrass_survey";
const DB_VERSION = 1;

let dbPromise = null;

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) {
        reject(new Error("This browser cannot store data on the device."));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("participants")) {
          db.createObjectStore("participants", { keyPath: "participant_id" });
        }
        if (!db.objectStoreNames.contains("meta")) {
          db.createObjectStore("meta", { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Close other copies of this app and reload."));
    });
  }
  return dbPromise;
}

async function store(name, mode) {
  const db = await openDb();
  return db.transaction(name, mode).objectStore(name);
}

async function finished(name, mode, work) {
  const db = await openDb();
  const tx = db.transaction(name, mode);
  const result = work(tx.objectStore(name));
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Storage transaction aborted"));
  });
  return result instanceof IDBRequest ? result.result : result;
}

export async function getParticipant(id) {
  return promisify((await store("participants", "readonly")).get(id));
}

export async function listParticipants() {
  return promisify((await store("participants", "readonly")).getAll());
}

// Resolves only after the write is committed to disk.
export function putParticipant(record) {
  return finished("participants", "readwrite", s => s.put(record));
}

export async function getMeta(key, fallback = null) {
  const row = await promisify((await store("meta", "readonly")).get(key));
  return row ? row.value : fallback;
}

export function setMeta(key, value) {
  return finished("meta", "readwrite", s => s.put({ key, value }));
}

// Ask the browser not to clear this app's data under storage pressure.
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      return (await navigator.storage.persisted()) || (await navigator.storage.persist());
    }
  } catch (_) { /* Not supported; data is still saved normally. */ }
  return false;
}
