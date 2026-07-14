// Receipt photos are real image blobs (hundreds of KB each), too large and
// too numerous to safely fit in localStorage's ~5-10MB quota. IndexedDB has
// no such practical limit and is built for exactly this kind of binary data,
// so the in-progress receipt photos are persisted here instead.

const DB_NAME = "fenua-check";
const STORE_NAME = "receipt-photos";
const SHELF_STORE_NAME = "shelf-photos";
const DB_VERSION = 2;

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
      if (!db.objectStoreNames.contains(SHELF_STORE_NAME)) {
        db.createObjectStore(SHELF_STORE_NAME, { keyPath: "id" });
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

// ---------------------------------------------------------------------------
// Shelf-tag photos (one per basket item, kept as evidence of the shelf price)
// ---------------------------------------------------------------------------

export async function saveShelfPhoto(itemId, file) {
  try {
    const db = await openDb();
    const tx = db.transaction(SHELF_STORE_NAME, "readwrite");
    tx.objectStore(SHELF_STORE_NAME).put({ id: itemId, blob: file, name: file.name, type: file.type });
    await new Promise((resolve) => {
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  } catch {
    // Non-critical: the item just won't have a shelf photo in the proof.
  }
}

export async function deleteShelfPhoto(itemId) {
  try {
    const db = await openDb();
    const tx = db.transaction(SHELF_STORE_NAME, "readwrite");
    tx.objectStore(SHELF_STORE_NAME).delete(itemId);
  } catch {
    // Non-critical.
  }
}

export async function loadShelfPhotos() {
  const map = new Map();
  try {
    const db = await openDb();
    const tx = db.transaction(SHELF_STORE_NAME, "readonly");
    const records = await new Promise((resolve, reject) => {
      const req = tx.objectStore(SHELF_STORE_NAME).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    for (const record of records) {
      const file = new File([record.blob], record.name || "etiquette.jpg", {
        type: record.type || "image/jpeg",
      });
      map.set(record.id, { file, previewUrl: URL.createObjectURL(file) });
    }
  } catch {
    // Non-critical: return whatever was gathered before the failure (none).
  }
  return map;
}

export async function clearShelfPhotos() {
  try {
    const db = await openDb();
    const tx = db.transaction(SHELF_STORE_NAME, "readwrite");
    tx.objectStore(SHELF_STORE_NAME).clear();
  } catch {
    // Non-critical.
  }
}
