// Save-slot persistence and rendering. Owns IndexedDB storage (with a one-time
// migration from the old localStorage data-URL slots); decorating and undo
// hooks come in from the caller so this module stays storage-only.

const DB_NAME = 'splotchbox';
const STORE_NAME = 'save-slots';
const THUMB_WIDTH = 144;
const THUMB_HEIGHT = 104;

export function createSlotStore({ container, canvas, context, storageKey, onBeforeDraw, onAfterDraw, onRender }) {
  // Only { id, thumb } stays in memory — full paintings are fetched per load.
  let slots = [];
  let dbPromise = null;
  let persistenceRequested = false;

  function openAt(version) {
    return new Promise((resolve, reject) => {
      const request = version === undefined
        ? window.indexedDB.open(DB_NAME)
        : window.indexedDB.open(DB_NAME, version);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function openDb() {
    if (!dbPromise) {
      // Self-healing open: a database can exist without the store (an open
      // aborted mid-upgrade, partial eviction). Detect that and bump the
      // version so the upgrade runs again, instead of failing forever.
      dbPromise = openAt().then((db) => {
        if (db.objectStoreNames.contains(STORE_NAME)) return db;
        const nextVersion = db.version + 1;
        db.close();
        return openAt(nextVersion);
      });
    }
    return dbPromise;
  }

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function isQuotaError(error) {
    return Boolean(error)
      && (error.name === 'QuotaExceededError'
        || error.code === 22
        || error.code === 1014);
  }

  function showSaveError(error) {
    if (isQuotaError(error)) {
      window.alert('There is no room to save another painting. Delete a saved painting and try again.');
      return;
    }
    window.alert('This painting could not be saved.');
  }

  // Slots are convenience storage the browser may evict; asking for
  // persistence is the cheap hedge. The durable copy is Save to Device.
  function requestPersistence() {
    if (persistenceRequested) return;
    persistenceRequested = true;
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }
  }

  async function generateThumb(blob) {
    const bitmap = await createImageBitmap(blob);
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = THUMB_WIDTH;
    thumbCanvas.height = THUMB_HEIGHT;
    const thumbContext = thumbCanvas.getContext('2d');
    thumbContext.fillStyle = '#fff';
    thumbContext.fillRect(0, 0, THUMB_WIDTH, THUMB_HEIGHT);
    const scale = Math.max(THUMB_WIDTH / bitmap.width, THUMB_HEIGHT / bitmap.height);
    const drawWidth = bitmap.width * scale;
    const drawHeight = bitmap.height * scale;
    thumbContext.drawImage(bitmap, (THUMB_WIDTH - drawWidth) / 2, (THUMB_HEIGHT - drawHeight) / 2, drawWidth, drawHeight);
    bitmap.close();
    return thumbCanvas.toDataURL('image/jpeg', 0.72);
  }

  function readLegacySlots() {
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored === null) return [];
      const parsed = JSON.parse(stored);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((slot) => typeof slot === 'string' && slot.startsWith('data:image/'));
    } catch (error) {
      return [];
    }
  }

  // All-or-nothing: records are prepared first and added in one transaction,
  // so a failure aborts wholesale and leaves the localStorage key for the
  // next attempt. The key is removed only after everything landed.
  async function migrateFromLocalStorage() {
    const legacy = readLegacySlots();
    if (legacy.length === 0) return;
    const records = [];
    for (const dataUrl of legacy) {
      const blob = await (await fetch(dataUrl)).blob();
      records.push({ blob, thumb: await generateThumb(blob), createdAt: Date.now() });
    }
    const db = await openDb();
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const added = await Promise.all(records.map((record) => requestToPromise(store.add(record))
      .then((id) => ({ id, thumb: record.thumb }))));
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    slots = [...slots, ...added];
    window.localStorage.removeItem(storageKey);
  }

  async function init() {
    try {
      const db = await openDb();
      const rows = await requestToPromise(db.transaction(STORE_NAME).objectStore(STORE_NAME).getAll());
      slots = rows.map(({ id, thumb }) => ({ id, thumb }));
      await migrateFromLocalStorage();
    } catch (error) {
      slots = [];
    }
    render();
  }

  function render() {
    container.replaceChildren();
    slots.forEach((slot, index) => {
      const item = document.createElement('div');
      item.className = 'save-slot';
      item.setAttribute('role', 'listitem');

      const loadButton = document.createElement('button');
      loadButton.type = 'button';
      loadButton.className = 'slot-load';
      loadButton.setAttribute('aria-label', `Load saved painting ${index + 1}`);
      const thumbnail = document.createElement('img');
      thumbnail.src = slot.thumb;
      thumbnail.alt = `Saved painting ${index + 1}`;
      loadButton.append(thumbnail);
      loadButton.addEventListener('click', () => { void load(index); });

      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'slot-delete';
      deleteButton.textContent = '×';
      deleteButton.setAttribute('aria-label', `Delete saved painting ${index + 1}`);
      deleteButton.addEventListener('click', () => { void remove(index); });

      item.append(loadButton, deleteButton);
      container.append(item);
    });
    onRender();
  }

  async function save() {
    try {
      const blob = await new Promise((resolve) => { canvas.toBlob(resolve, 'image/png'); });
      if (!blob) throw new Error('The painting could not be serialized.');
      const thumb = await generateThumb(blob);
      const db = await openDb();
      const id = await requestToPromise(
        db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).add({ blob, thumb, createdAt: Date.now() }),
      );
      slots = [...slots, { id, thumb }];
      requestPersistence();
      render();
      return true;
    } catch (error) {
      showSaveError(error);
      return false;
    }
  }

  async function load(index) {
    if (!Number.isInteger(index) || index < 0 || index >= slots.length) return false;
    try {
      const db = await openDb();
      const row = await requestToPromise(db.transaction(STORE_NAME).objectStore(STORE_NAME).get(slots[index].id));
      if (!row) return false;
      const bitmap = await createImageBitmap(row.blob);
      onBeforeDraw();
      // Use backing-store dimensions deliberately: an image saved at a different
      // devicePixelRatio still covers the same CSS-space painting on restore.
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      context.restore();
      bitmap.close();
      if (onAfterDraw) onAfterDraw();
      return true;
    } catch (error) {
      return false;
    }
  }

  async function remove(index) {
    if (!Number.isInteger(index) || index < 0 || index >= slots.length) return false;
    try {
      const db = await openDb();
      await requestToPromise(db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(slots[index].id));
      slots = slots.filter((slot, slotIndex) => slotIndex !== index);
      render();
      return true;
    } catch (error) {
      showSaveError(error);
      return false;
    }
  }

  function getAll() {
    return slots.map((slot) => slot.thumb);
  }

  const ready = init();

  return { render, save, load, remove, getAll, ready };
}
