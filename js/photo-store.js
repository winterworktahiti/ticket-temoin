// Receipt photos are real image blobs (hundreds of KB each), too large and
// too numerous to safely fit in localStorage's ~5-10MB quota. IndexedDB has
// no such practical limit and is built for exactly this kind of binary data,
// so the in-progress receipt photos are persisted here instead.

const DB_NAME = "fenua-check";
const STORE_NAME = "receipt-photos";
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function savePersistedPhotos(photos) {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    for (const photo of photos) {
      store.put({ id: photo.id, blob: photo.file, name: photo.file.name, type: photo.file.type });
    }
    await new Promise((resolve) => {
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  } catch {
    // Non-critical: if IndexedDB is unavailable, the app still works, the
    // user just needs to re-add receipt photos after a reload.
  }
}

export async function loadPersistedPhotos() {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const records = await new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    return records.map((record) => {
      const file = new File([record.blob], record.name || "receipt.jpg", {
        type: record.type || "image/jpeg",
      });
      return { id: record.id, file, previewUrl: URL.createObjectURL(file) };
    });
  } catch {
    return [];
  }
}

export async function clearPersistedPhotos() {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).clear();
  } catch {
    // Non-critical.
  }
}
