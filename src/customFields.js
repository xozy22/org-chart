/**
 * Settings UI for managing user-defined custom fields.
 *
 * The store holds a list of `{ key, label, type, showOnCard }` definitions.
 * This module:
 *   - opens / closes the settings modal
 *   - renders the existing field rows (with a remove button each)
 *   - validates and submits new fields via a small inline form
 *
 * Adding / removing fields is wired through `store.addCustomField` and
 * `store.removeCustomField`, which keep the per-node values in sync and
 * persist to localStorage.
 */

const VALID_TYPES = ['text', 'number', 'date', 'url', 'email'];

function $(sel) {
  return document.querySelector(sel);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function setupCustomFieldsUI({ store, onChange }) {
  const modal = $('#settings-modal');
  const list = $('#custom-fields-list');
  const form = $('#custom-field-form');
  const openBtn = $('#btn-settings');

  function renderList() {
    if (!list) return;
    if (store.customFields.length === 0) {
      list.innerHTML =
        '<div class="modal-hint" style="opacity:0.7;">Noch keine eigenen Felder definiert.</div>';
      return;
    }
    list.innerHTML = store.customFields
      .map(
        (f) => `
          <div class="custom-field-row" data-field="${escapeHtml(f.key)}">
            <span class="cf-label">${escapeHtml(f.label)}</span>
            <span class="cf-key">${escapeHtml(f.key)}</span>
            <span class="cf-type">${escapeHtml(f.type)}</span>
            <label class="cf-show">
              <input type="checkbox" data-action="toggle-show" ${f.showOnCard ? 'checked' : ''} />
              auf Karte
            </label>
            <button type="button" class="cf-remove" data-action="remove" title="Feld löschen">×</button>
          </div>
        `,
      )
      .join('');
  }

  function open() {
    if (!modal) return;
    renderList();
    modal.hidden = false;
    setTimeout(() => form?.elements?.namedItem('key')?.focus(), 30);
  }
  function close() {
    if (modal) modal.hidden = true;
  }

  // Open / close wiring
  openBtn?.addEventListener('click', open);
  modal?.addEventListener('click', (ev) => {
    const target = ev.target;
    if (target instanceof HTMLElement && target.hasAttribute('data-close')) {
      close();
    }
  });

  // Per-row actions: remove + toggle visibility on card
  list?.addEventListener('click', (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLElement)) return;
    const row = target.closest('[data-field]');
    if (!row) return;
    const key = row.getAttribute('data-field');
    if (!key) return;

    if (target.matches('[data-action="remove"]')) {
      const ok = window.confirm(
        `Feld „${key}" entfernen? Die in den Knoten gespeicherten Werte werden ebenfalls gelöscht.`,
      );
      if (!ok) return;
      store.removeCustomField(key);
      renderList();
      onChange?.();
    }
  });

  list?.addEventListener('change', (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.dataset.action !== 'toggle-show') return;
    const row = target.closest('[data-field]');
    const key = row?.getAttribute('data-field');
    if (!key) return;
    store.updateCustomField(key, { showOnCard: target.checked });
    onChange?.();
  });

  form?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const data = new FormData(form);
    const key = String(data.get('key') || '').trim();
    const label = String(data.get('label') || '').trim();
    const type = VALID_TYPES.includes(String(data.get('type'))) ? String(data.get('type')) : 'text';
    const showOnCard = !!data.get('showOnCard');
    if (!key || !label) return;
    try {
      store.addCustomField({ key, label, type, showOnCard });
    } catch (err) {
      window.alert(err.message);
      return;
    }
    form.reset();
    // Re-tick the default for showOnCard since reset() unchecks it
    const cb = form.elements.namedItem('showOnCard');
    if (cb instanceof HTMLInputElement) cb.checked = true;
    renderList();
    onChange?.();
  });

  // Esc closes the modal when it's open and focus is outside form fields
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && modal && !modal.hidden) {
      // Don't double-fire if the active element is a form field (Esc there
      // is fine to allow closure too).
      close();
    }
  });

  return { open, close, renderList };
}
