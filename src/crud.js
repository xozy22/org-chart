import { COUNTRIES, countryCode, countryName } from './countries.js';
import { defaultDepartmentColor } from './departments.js';

const FIELDS = ['id', 'parentId', 'name', 'title', 'department', 'email', 'phone', 'imageUrl', 'country'];

function $(sel, root = document) {
  return root.querySelector(sel);
}

function populateCountryDatalist() {
  const list = $('#country-list');
  if (!list || list.dataset.populated) return;
  list.innerHTML = COUNTRIES
    .map((c) => `<option value="${c.name}" data-code="${c.code}">${c.code.toUpperCase()} — ${c.name}</option>`)
    .join('');
  list.dataset.populated = '1';
}

function populateDepartmentDatalist(store) {
  const list = $('#department-list');
  if (!list) return;
  const items = store.listDepartments();
  list.innerHTML = items
    .map((name) => `<option value="${name.replace(/"/g, '&quot;')}"></option>`)
    .join('');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Render the dynamic custom-fields section in the node modal. */
function renderCustomFields(store) {
  const slot = $('#custom-fields-slot');
  if (!slot) return;
  const fields = store.customFields || [];
  if (fields.length === 0) {
    slot.innerHTML = '';
    return;
  }
  slot.innerHTML = fields
    .map(
      (f) => `
        <label data-custom="${escapeHtml(f.key)}">
          <span>${escapeHtml(f.label)}</span>
          <input
            name="${escapeHtml(f.key)}"
            type="${escapeHtml(f.type || 'text')}"
            data-custom-field="1"
            autocomplete="off"
          />
        </label>
      `,
    )
    .join('');
}

export function setupModal({ store, onChange }) {
  const modal = $('#modal');
  const form = $('#node-form');
  const titleEl = $('#modal-title');
  const deleteBtn = $('#btn-delete');
  const countryFlag = $('#country-flag-preview');
  const countryInput = form.elements.namedItem('country');
  const countryClearBtn = $('#country-clear');
  const deptInput = form.elements.namedItem('department');
  const deptColorInput = form.elements.namedItem('departmentColor');

  populateCountryDatalist();

  function syncFlagPreview() {
    const value = countryInput?.value || '';
    const code = countryCode(value);
    if (countryFlag) {
      countryFlag.className = code ? `field-flag fi fi-${code}` : 'field-flag field-flag--empty';
      countryFlag.title = code ? countryName(code) : '';
    }
    if (countryClearBtn) {
      countryClearBtn.classList.toggle('is-visible', value.trim().length > 0);
    }
  }

  countryInput?.addEventListener('input', syncFlagPreview);
  countryInput?.addEventListener('change', syncFlagPreview);

  // UX: when the user clicks/focuses the country field, select the existing
  // value so they can immediately overwrite it instead of having to clear it
  // by hand. This was the source of the "I can't change the flag" feedback.
  countryInput?.addEventListener('focus', () => {
    if (countryInput.value) {
      // Defer so the cursor placement from the click happens first.
      setTimeout(() => countryInput.select(), 0);
    }
  });

  countryClearBtn?.addEventListener('click', () => {
    if (!countryInput) return;
    countryInput.value = '';
    syncFlagPreview();
    countryInput.focus();
  });

  const swatches = Array.from(form.querySelectorAll('.color-swatch'));

  function markActiveSwatch(hex) {
    const target = (hex || '').toLowerCase();
    swatches.forEach((sw) => {
      const c = (sw.dataset.color || '').toLowerCase();
      sw.classList.toggle('is-active', c === target);
    });
  }

  function setDeptColor(hex) {
    if (!deptColorInput || !hex) return;
    deptColorInput.value = hex;
    markActiveSwatch(hex);
  }

  function syncDeptColor() {
    if (!deptColorInput) return;
    const name = (deptInput?.value || '').trim();
    if (!name) {
      setDeptColor('#9ca3af');
      return;
    }
    // Use explicit color if known, otherwise the stable default — so the
    // picker always shows the colour the badge will actually render with.
    const color = store.departments[name] || defaultDepartmentColor(name);
    setDeptColor(color);
  }

  deptInput?.addEventListener('input', syncDeptColor);
  deptInput?.addEventListener('change', syncDeptColor);

  swatches.forEach((sw) => {
    sw.addEventListener('click', (ev) => {
      ev.preventDefault();
      const c = sw.dataset.color;
      if (c) setDeptColor(c);
    });
  });

  // Custom-picker: when the user changes it, drop any active preset highlight.
  deptColorInput?.addEventListener('input', () => {
    markActiveSwatch(deptColorInput.value);
  });

  let mode = 'add';
  let currentId = null;

  function openModal() {
    modal.hidden = false;
    setTimeout(() => form.querySelector('input[name="name"]').focus(), 30);
  }

  function closeModal() {
    modal.hidden = true;
    form.reset();
    currentId = null;
  }

  function fillForm(node) {
    FIELDS.forEach((key) => {
      const input = form.elements.namedItem(key);
      if (!input) return;
      if (key === 'country') {
        // Show the localized country name in the input; the underlying value stays the ISO code via resolve.
        const code = node?.country ?? '';
        input.value = code ? countryName(code) || code : '';
      } else {
        input.value = node?.[key] ?? '';
      }
    });
    // Custom fields (rendered dynamically — query by data attribute)
    for (const cf of store.customFields || []) {
      const input = form.elements.namedItem(cf.key);
      if (input instanceof HTMLInputElement) {
        input.value = node?.[cf.key] ?? '';
      }
    }
    syncFlagPreview();
    syncDeptColor();
  }

  function readForm() {
    const data = {};
    FIELDS.forEach((key) => {
      const input = form.elements.namedItem(key);
      const v = input?.value?.trim() ?? '';
      if (key === 'country') {
        data.country = countryCode(v) ?? '';
      } else {
        data[key] = v === '' ? null : v;
      }
    });
    // Custom fields — pass-through, empty strings stored as ''
    const custom = {};
    for (const cf of store.customFields || []) {
      const input = form.elements.namedItem(cf.key);
      if (input instanceof HTMLInputElement) {
        custom[cf.key] = (input.value || '').trim();
      }
    }
    data._custom = custom;
    return data;
  }

  function openForCreate({ parentId = null } = {}) {
    mode = 'add';
    titleEl.textContent = parentId ? 'Untergeordneten Knoten hinzufügen' : 'Neuen Knoten hinzufügen';
    deleteBtn.hidden = true;
    populateDepartmentDatalist(store);
    renderCustomFields(store);
    fillForm({ id: store.nextId(), parentId, name: '', title: '', department: '', email: '', phone: '', imageUrl: '', country: '' });
    openModal();
  }

  function openForEdit(id) {
    const node = store.byId(id);
    if (!node) return;
    mode = 'edit';
    currentId = node.id;
    titleEl.textContent = 'Knoten bearbeiten';
    deleteBtn.hidden = false;
    populateDepartmentDatalist(store);
    renderCustomFields(store);
    fillForm(node);
    openModal();
  }

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const data = readForm();
    if (!data.name) return;
    if (!data.id) data.id = store.nextId();

    // Persist the chosen department colour. We store it only when the user
    // either picked a new colour or has not stored one yet — no point in
    // saving a value identical to the stable hash default.
    const deptName = (data.department || '').trim();
    const pickedColor = (deptColorInput?.value || '').toLowerCase();
    if (deptName && pickedColor) {
      const existing = (store.departments[deptName] || '').toLowerCase();
      const fallback = defaultDepartmentColor(deptName).toLowerCase();
      if (pickedColor !== existing && pickedColor !== fallback) {
        store.setDepartmentColor(deptName, pickedColor);
      } else if (!existing && pickedColor !== fallback) {
        store.setDepartmentColor(deptName, pickedColor);
      }
    }

    if (mode === 'add') {
      store.add({
        id: data.id,
        parentId: data.parentId ?? null,
        name: data.name,
        title: data.title,
        department: data.department,
        email: data.email,
        phone: data.phone,
        imageUrl: data.imageUrl,
        country: data.country ?? '',
        ...(data._custom || {}),
      });
    } else {
      store.update(currentId, {
        name: data.name,
        title: data.title,
        department: data.department,
        email: data.email,
        phone: data.phone,
        imageUrl: data.imageUrl,
        country: data.country ?? '',
        ...(data._custom || {}),
      });
    }

    closeModal();
    onChange?.();
  });

  deleteBtn.addEventListener('click', () => {
    if (!currentId) return;
    const node = store.byId(currentId);
    if (!node) return;
    const ok = window.confirm(
      `"${node.name}" löschen? Untergeordnete Knoten werden eine Ebene nach oben verschoben.`,
    );
    if (!ok) return;
    store.remove(currentId, { reparentChildren: true });
    closeModal();
    onChange?.();
  });

  modal.addEventListener('click', (ev) => {
    if (ev.target instanceof HTMLElement && ev.target.hasAttribute('data-close')) {
      closeModal();
    }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !modal.hidden) closeModal();
  });

  return { openForCreate, openForEdit, closeModal };
}
