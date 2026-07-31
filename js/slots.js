// Save-slot persistence and rendering. Owns localStorage; decorating and undo
// hooks come in from the caller so this module stays storage-only.

export function createSlotStore({ container, canvas, context, storageKey, onBeforeDraw, onAfterDraw, onRender }) {
  let slots = readSlots();

  function readSlots() {
    try {
      const storedSlots = window.localStorage.getItem(storageKey);
      if (storedSlots === null) return [];
      const parsedSlots = JSON.parse(storedSlots);
      if (!Array.isArray(parsedSlots)) return [];
      return parsedSlots.filter((slot) => typeof slot === 'string' && slot.startsWith('data:image/'));
    } catch (error) {
      return [];
    }
  }

  function isQuotaError(error) {
    return Boolean(error)
      && (error.name === 'QuotaExceededError'
        || error.code === 22
        || error.code === 1014);
  }

  function persistSlots(nextSlots) {
    window.localStorage.setItem(storageKey, JSON.stringify(nextSlots));
    slots = nextSlots;
  }

  function showSaveError(error) {
    if (isQuotaError(error)) {
      window.alert('There is no room to save another painting. Delete a saved painting and try again.');
      return;
    }
    window.alert('This painting could not be saved.');
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
      thumbnail.src = slot;
      thumbnail.alt = `Saved painting ${index + 1}`;
      loadButton.append(thumbnail);
      loadButton.addEventListener('click', () => { void load(index); });

      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'slot-delete';
      deleteButton.textContent = '×';
      deleteButton.setAttribute('aria-label', `Delete saved painting ${index + 1}`);
      deleteButton.addEventListener('click', () => { remove(index); });

      item.append(loadButton, deleteButton);
      container.append(item);
    });
    onRender();
  }

  function save() {
    const newSlot = canvas.toDataURL('image/png');
    const nextSlots = [...slots, newSlot];
    try {
      persistSlots(nextSlots);
    } catch (error) {
      showSaveError(error);
      return false;
    }
    render();
    return true;
  }

  function drawSlot(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.addEventListener('load', () => {
        onBeforeDraw();
        // Use backing-store dimensions deliberately: an image saved at a different
        // devicePixelRatio still covers the same CSS-space painting on restore.
        context.save();
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        context.restore();
        if (onAfterDraw) onAfterDraw();
        resolve();
      }, { once: true });
      image.addEventListener('error', () => reject(new Error('Saved painting could not be loaded.')), { once: true });
      image.src = dataUrl;
    });
  }

  function load(index) {
    if (!Number.isInteger(index) || index < 0 || index >= slots.length) return Promise.resolve(false);
    return drawSlot(slots[index]).then(() => true, () => false);
  }

  function remove(index) {
    if (!Number.isInteger(index) || index < 0 || index >= slots.length) return false;
    const nextSlots = slots.filter((slot, slotIndex) => slotIndex !== index);
    try {
      persistSlots(nextSlots);
    } catch (error) {
      showSaveError(error);
      return false;
    }
    render();
    return true;
  }

  function getAll() {
    return [...slots];
  }

  return { render, save, load, remove, getAll };
}
