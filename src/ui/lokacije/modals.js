/**
 * Modali — Nova lokacija, Brzo premeštanje (RPC loc_create_movement).
 */

import { escHtml, showToast } from '../../lib/dom.js';
import {
  HALL_TYPE_OPTIONS,
  canBeShelfParent,
  getLocationKindLabel,
  getLocationTypeLabel,
  isHallType,
  isShelfType,
} from '../../lib/lokacijeTypes.js';
import { canEdit } from '../../state/auth.js';
import {
  createLocation,
  fetchItemMovements,
  fetchItemPlacements,
  fetchLocations,
  locCreateMovement,
  updateLocation,
} from '../../services/lokacije.js';
import {
  fetchBigtehnOpSnapshotByRnAndTp,
  fetchTpOptionsForPredmetOrder,
} from '../../services/planProizvodnje.js';
import { getIsOnline } from '../../state/auth.js';

/* TRANSFER je prvi jer je najčešći slučaj u svakodnevnom radu;
 * INITIAL_PLACEMENT je eksplicitno drugačiji tok (samo za nove stavke). */
const MOVEMENT_TYPES = [
  'TRANSFER',
  'INITIAL_PLACEMENT',
  'ASSIGN_TO_PROJECT',
  'RETURN_FROM_PROJECT',
  'SEND_TO_SERVICE',
  'RETURN_FROM_SERVICE',
  'SEND_TO_FIELD',
  'RETURN_FROM_FIELD',
  'SCRAP',
  'CORRECTION',
  'INVENTORY_ADJUSTMENT',
];

/** Brzo premeštanje uvek vezuje stavku za BigTehn RN cache (bridge). */
const LOC_QM_ITEM_REF_TABLE = 'bigtehn_rn';

/* Isti ključ kao scanModal — deli se lokalni keš broja crteža. */
const DRAWING_CACHE_KEY = 'loc_drawing_cache_v1';

function qmReadDrawingCache() {
  try {
    const raw = localStorage.getItem(DRAWING_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function qmGetDrawingCache(orderNo, tp) {
  if (!orderNo || !tp) return '';
  return qmReadDrawingCache()[`${orderNo}|${tp}`] || '';
}

function qmSetDrawingCache(orderNo, tp, drawingNo) {
  if (!orderNo || !tp || !drawingNo) return;
  const key = `${orderNo}|${tp}`;
  const cache = qmReadDrawingCache();
  cache[key] = String(drawingNo);
  try {
    localStorage.setItem(DRAWING_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* ignore */
  }
}

/**
 * Ne-breaking space indent zavisno od `depth`.
 * @param {number} depth
 */
function indentFor(depth) {
  const n = Math.max(0, Math.min(Number(depth) || 0, 12));
  return n === 0 ? '' : '\u00a0\u00a0'.repeat(n) + '· ';
}

/**
 * HTML <option> redovi za dropdown sa indentiranim prikazom hijerarhije.
 * Ulazna lista je već sortirana po `path_cached` (fetchLocations order).
 * @param {object[]} locs
 * @param {{ blankLabel?: string, includeBlank?: boolean }} [opts]
 */
function locationOptionsHtml(locs, { blankLabel = '', includeBlank = true } = {}) {
  const rows = [];
  if (includeBlank) rows.push(`<option value="">${escHtml(blankLabel)}</option>`);
  for (const l of locs) {
    const indent = indentFor(l.depth);
    const label = `${indent}${l.location_code || ''} — ${l.name || ''}`;
    rows.push(`<option value="${escHtml(String(l.id))}">${escHtml(label)}</option>`);
  }
  return rows.join('');
}

/**
 * Registruje Esc-key listener koji zatvara modal, i vraća cleanup funkciju.
 * @param {() => void} onClose
 */
function bindEscClose(onClose) {
  const handler = ev => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      onClose();
    }
  };
  document.addEventListener('keydown', handler);
  return () => document.removeEventListener('keydown', handler);
}

function movementErrMsg(code, res) {
  if (!code) return 'Operacija nije uspela.';
  const r = res && typeof res === 'object' ? res : {};
  if (code === 'exception') {
    const d = r.detail != null ? String(r.detail) : '';
    return d ? `Greška na serveru: ${d}` : 'Greška na serveru (bez detalja).';
  }
  const m = {
    missing_fields: 'Popuni sva obavezna polja.',
    bad_to_location: 'Odredišna lokacija nije validna ili nije aktivna.',
    bad_to_uuid: 'Odredišna lokacija ima neispravan ID.',
    bad_from_uuid: 'Polazna lokacija ima neispravan ID.',
    bad_movement_type: 'Neispravan tip pokreta.',
    bad_quantity: 'Količina mora biti veća od 0.',
    bad_order_no: 'Broj naloga je predugačak (max 40 karaktera).',
    bad_drawing_no: 'Broj crteža je predugačak (max 40 karaktera).',
    already_placed:
      'Stavka već ima postojeće placement-e — koristi TRANSFER (ili INVENTORY_ADJUSTMENT da dodaš još komada).',
    no_current_placement:
      'Stavka nije trenutno nigde smeštena — prvo iskoristi INITIAL_PLACEMENT.',
    from_has_no_placement:
      'Na izabranoj polaznoj lokaciji nema komada ove stavke.',
    from_ambiguous:
      'Stavka se trenutno nalazi na više lokacija — eksplicitno izaberi polaznu.',
    from_mismatch: 'Polazna lokacija ne odgovara trenutnoj.',
    insufficient_quantity:
      r.available != null
        ? `Tražena količina (${r.requested ?? '?'}) je veća od raspoložive na polaznoj lokaciji (${r.available}).`
        : 'Tražena količina je veća od raspoložive na polaznoj lokaciji.',
    not_authenticated: 'Prijavi se ponovo.',
  };
  return m[code] || String(code);
}

function removeModal(id) {
  document.getElementById(id)?.remove();
}

/**
 * Pravi shell modala sa loading sadržajem. Vraća elemente za kasniju zamenu.
 * @param {{ id: string, title: string, subtitle?: string }} params
 */
function createModalShell({ id, title, subtitle = '' }) {
  removeModal(id);
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="kadr-modal-overlay" id="${id}" role="dialog" aria-labelledby="${id}Title" aria-modal="true">
      <div class="kadr-modal">
        <div class="kadr-modal-title" id="${id}Title">${escHtml(title)}</div>
        ${subtitle ? `<div class="kadr-modal-subtitle">${subtitle}</div>` : ''}
        <div class="kadr-modal-body" data-modal-body>
          <p class="loc-muted" style="padding:24px 0; text-align:center">Učitavam lokacije…</p>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap.firstElementChild);
  const overlay = document.getElementById(id);
  return {
    overlay,
    body: overlay.querySelector('[data-modal-body]'),
  };
}

/**
 * Modal za kreiranje ili izmenu master lokacije.
 *
 * UX: koristimo operativne termine POLICA / HALA umesto tehničkih (šifra,
 * tip, roditelj). Backend kolone `location_code`, `location_type`, `parent_id`
 * ostaju iste — samo je UI preveden.
 *
 * Mapiranje:
 *   - POLICA  = location_type SHELF. Parent je obavezno neka HALA
 *               (WAREHOUSE/PRODUCTION/ASSEMBLY/FIELD/TEMP).
 *   - HALA    = jedan od HALA tipova. Parent je null (root).
 *
 * Za izmenu postojeće lokacije ne menjamo tip (SHELF ostaje SHELF, WAREHOUSE
 * ostaje WAREHOUSE) — to je retka operacija i može se uraditi direktno u bazi
 * ako stvarno treba.
 *
 * @param {{ existing?: object|null, onSuccess?: () => void }} [opts]
 */
export function openLocationModal({ existing = null, onSuccess } = {}) {
  if (!canEdit()) {
    showToast('⚠ Samo admin / LeadPM / PM / Menadžment može da menja lokacije');
    return;
  }

  const isEdit = !!existing;
  const modalId = 'locModalNewLoc';
  const { overlay, body } = createModalShell({
    id: modalId,
    title: isEdit ? 'Izmeni lokaciju' : 'Nova lokacija',
    subtitle: isEdit
      ? 'Menjaju se naziv i opis; šifra i tip ostaju isti.'
      : 'Izaberi šta dodaješ — policu unutar hale, ili novu halu / zonu.',
  });

  let unbindEsc = null;
  const close = () => {
    if (unbindEsc) {
      unbindEsc();
      unbindEsc = null;
    }
    removeModal(modalId);
  };
  unbindEsc = bindEscClose(close);
  overlay.addEventListener('click', ev => {
    if (ev.target === overlay) close();
  });

  (async () => {
    const locs = await fetchLocations({ activeOnly: false });
    if (!Array.isArray(locs)) {
      close();
      showToast('⚠ Ne mogu da učitam lokacije');
      return;
    }

    if (isEdit) {
      renderEditForm({
        overlay,
        body,
        existing,
        close,
        onSuccess,
      });
      return;
    }

    renderPickerStage({
      overlay,
      body,
      locs,
      close,
      onSuccess,
    });
  })();
}

/**
 * "Šta dodaješ?" — dve velike kartice iznad konkretne forme. Klik otvara
 * pripadajuću formu (polica ili hala) u istom modalu (swap body.innerHTML).
 */
function renderPickerStage({ overlay, body, locs, close, onSuccess }) {
  body.innerHTML = `
    <div class="loc-picker-row">
      <button type="button" class="loc-picker-card" data-kind="shelf">
        <span class="loc-picker-ico">📍</span>
        <span class="loc-picker-title">POLICA</span>
        <span class="loc-picker-sub">Konkretno mesto unutar hale<br><em>npr. A23, B12, K-A3</em></span>
      </button>
      <button type="button" class="loc-picker-card" data-kind="hall">
        <span class="loc-picker-ico">🏭</span>
        <span class="loc-picker-title">HALA</span>
        <span class="loc-picker-sub">Veći prostor / magacin<br><em>npr. MAG, Hala 2, Hala 2a</em></span>
      </button>
    </div>
    <div class="kadr-modal-actions">
      <button type="button" class="btn" data-act="picker-cancel">Otkaži</button>
    </div>
  `;

  overlay.querySelector('[data-act="picker-cancel"]').addEventListener('click', close);

  overlay.querySelectorAll('[data-kind]').forEach(btn => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.kind;
      if (kind === 'shelf') {
        renderShelfForm({ overlay, body, locs, close, onSuccess });
      } else if (kind === 'hall') {
        renderHallForm({ overlay, body, close, onSuccess });
      }
    });
  });
}

/**
 * Forma za POLICU — user unosi oznaku (A1/B12) + opis + bira halu iz
 * postojećih. Ima i "Dodaj više odjednom" bulk generator sa slovo × raspon.
 */
function renderShelfForm({ overlay, body, locs, close, onSuccess }) {
  const halls = locs.filter(canBeShelfParent);

  if (!halls.length) {
    body.innerHTML = `
      <div class="loc-empty-card">
        <div class="loc-empty-title">⚠ Nema definisanih hala</div>
        <p>Prvo dodaj bar jednu halu (npr. "MAG — Centralni magacin"), pa se vrati da dodaš police u njoj.</p>
        <div class="kadr-modal-actions">
          <button type="button" class="btn" data-act="back">← Nazad</button>
          <button type="button" class="btn btn-primary" data-act="add-hall">Dodaj halu</button>
        </div>
      </div>
    `;
    overlay.querySelector('[data-act="back"]').addEventListener('click', () => {
      renderPickerStage({ overlay, body, locs, close, onSuccess });
    });
    overlay.querySelector('[data-act="add-hall"]').addEventListener('click', () => {
      renderHallForm({ overlay, body, close, onSuccess });
    });
    return;
  }

  const hallOpts = halls
    .map(
      h =>
        `<option value="${escHtml(String(h.id))}" data-code="${escHtml(h.location_code || '')}">${escHtml(h.location_code || '')} — ${escHtml(h.name || '')} (${escHtml(getLocationTypeLabel(h.location_type))})</option>`,
    )
    .join('');

  const prefixBtns = ['A', 'B', 'C', 'D', 'F']
    .map(
      p =>
        `<button type="button" class="loc-prefix-btn" data-prefix="${p}" title="Brzi izbor slova">${p}</button>`,
    )
    .join('');

  body.innerHTML = `
    <div class="loc-form-breadcrumb">
      <button type="button" class="loc-breadcrumb-back" data-act="back">←</button>
      <span>Nova polica</span>
    </div>

    <div class="kadr-modal-err" id="locModalNewLocErr"></div>
    <form id="locFormNewShelf">
      <div class="emp-form-grid">
        <div class="emp-field col-full">
          <label for="locShelfHall">Pripada hali *</label>
          <select id="locShelfHall" required>${hallOpts}</select>
        </div>

        <div class="emp-field">
          <label for="locShelfSlot">Oznaka police *
            <span class="loc-muted" style="font-weight:400;font-size:12px">— primer: A23, B12, C5</span>
          </label>
          <div class="loc-prefix-row">${prefixBtns}</div>
          <input type="text" id="locShelfSlot" required maxlength="40" placeholder="npr. A23"
                 autocomplete="off" style="text-transform:uppercase" />
        </div>

        <div class="emp-field">
          <label for="locShelfDesc">Kratak opis *
            <span class="loc-muted" style="font-weight:400;font-size:12px">— šta se drži ovde</span>
          </label>
          <input type="text" id="locShelfDesc" required maxlength="200" placeholder="npr. Farbanje, Završna, Dorada">
        </div>
      </div>

      <!-- Bulk generator: dodaj više polica odjednom (tipično "A1…A30" po
           uzoru na postojeće K-A1..K-A6). Rasterećuje admin-a od 30 klikova. -->
      <details class="loc-bulk-details">
        <summary>➕ Dodaj više polica odjednom (bulk)</summary>
        <div class="loc-bulk-grid">
          <div class="emp-field">
            <label for="locShelfBulkPrefix">Slovo</label>
            <select id="locShelfBulkPrefix">
              <option value="A">A</option>
              <option value="B">B</option>
              <option value="C">C</option>
              <option value="D">D</option>
              <option value="F">F</option>
            </select>
          </div>
          <div class="emp-field">
            <label for="locShelfBulkFrom">Od broja</label>
            <input type="number" id="locShelfBulkFrom" min="1" max="999" value="1">
          </div>
          <div class="emp-field">
            <label for="locShelfBulkTo">Do broja</label>
            <input type="number" id="locShelfBulkTo" min="1" max="999" value="30">
          </div>
          <div class="emp-field col-full">
            <label for="locShelfBulkDesc">Opis za sve (isti)</label>
            <input type="text" id="locShelfBulkDesc" maxlength="200" placeholder="npr. Farbanje">
          </div>
          <div class="emp-field col-full">
            <div class="loc-muted" id="locShelfBulkPreview" style="font-size:12px"></div>
          </div>
          <div class="emp-field col-full">
            <button type="button" class="btn" id="locShelfBulkSubmit">Napravi sve</button>
          </div>
        </div>
      </details>

      <div class="kadr-modal-actions">
        <button type="button" class="btn" data-act="cancel">Otkaži</button>
        <button type="submit" class="btn btn-primary" id="locShelfSubmit">Sačuvaj policu</button>
      </div>
    </form>
  `;

  const errEl = overlay.querySelector('#locModalNewLocErr');
  const slotInput = overlay.querySelector('#locShelfSlot');
  const hallSel = overlay.querySelector('#locShelfHall');
  const descInput = overlay.querySelector('#locShelfDesc');
  const submitBtn = overlay.querySelector('#locShelfSubmit');

  overlay.querySelector('[data-act="cancel"]').addEventListener('click', close);
  overlay.querySelector('[data-act="back"]').addEventListener('click', () => {
    renderPickerStage({ overlay, body, locs, close, onSuccess });
  });

  overlay.querySelectorAll('[data-prefix]').forEach(btn => {
    btn.addEventListener('click', () => {
      /* Ubaci prefiks u slot ako je polje prazno, inače zameni prvo slovo. */
      const p = btn.dataset.prefix;
      const cur = slotInput.value.trim();
      slotInput.value = cur.match(/^[A-Z]/) ? p + cur.slice(1) : p + (cur || '1');
      slotInput.focus();
    });
  });

  slotInput.addEventListener('input', () => {
    slotInput.value = slotInput.value.toUpperCase();
  });

  hallSel.focus();

  /* ── Bulk generator logic ── */
  const bulkPrefix = overlay.querySelector('#locShelfBulkPrefix');
  const bulkFrom = overlay.querySelector('#locShelfBulkFrom');
  const bulkTo = overlay.querySelector('#locShelfBulkTo');
  const bulkDesc = overlay.querySelector('#locShelfBulkDesc');
  const bulkPreview = overlay.querySelector('#locShelfBulkPreview');
  const bulkSubmit = overlay.querySelector('#locShelfBulkSubmit');

  function updateBulkPreview() {
    const p = bulkPrefix.value;
    const from = Math.max(1, Math.min(999, Number(bulkFrom.value) || 1));
    const to = Math.max(1, Math.min(999, Number(bulkTo.value) || 1));
    const count = Math.max(0, to - from + 1);
    const hallCode = hallSel.selectedOptions[0]?.dataset?.code || '';
    const example = `${hallCode ? hallCode + '-' : ''}${p}${from}, ${hallCode ? hallCode + '-' : ''}${p}${from + 1}, ...`;
    bulkPreview.textContent = `Kreiraće se ${count} polica: ${example}`;
  }
  [bulkPrefix, bulkFrom, bulkTo, hallSel].forEach(el => el.addEventListener('input', updateBulkPreview));
  updateBulkPreview();

  bulkSubmit.addEventListener('click', async () => {
    errEl.textContent = '';
    const parent_id = hallSel.value || null;
    if (!parent_id) {
      errEl.textContent = 'Prvo izaberi halu.';
      return;
    }
    const hallCode = hallSel.selectedOptions[0]?.dataset?.code || '';
    const p = bulkPrefix.value;
    const from = Math.max(1, Math.min(999, Number(bulkFrom.value) || 1));
    const to = Math.max(1, Math.min(999, Number(bulkTo.value) || 1));
    const desc = bulkDesc.value.trim();
    if (to < from) {
      errEl.textContent = '"Do broja" mora biti >= "Od broja".';
      return;
    }
    if (!desc) {
      errEl.textContent = 'Unesi opis koji se primenjuje na sve nove police.';
      return;
    }
    const count = to - from + 1;
    if (count > 100) {
      if (!window.confirm(`Hoćeš da napraviš ${count} polica odjednom?`)) return;
    }

    bulkSubmit.disabled = true;
    let ok = 0;
    let failed = 0;
    for (let n = from; n <= to; n++) {
      const slot = `${p}${n}`;
      const location_code = hallCode ? `${hallCode}-${slot}` : slot;
      const row = await createLocation({
        location_code,
        name: desc,
        location_type: 'SHELF',
        parent_id,
      }).catch(() => null);
      if (row) ok++;
      else failed++;
    }
    bulkSubmit.disabled = false;
    if (failed > 0) {
      showToast(`⚠ Kreirano ${ok}, nije uspelo ${failed} (verovatno duplikat šifre)`);
    } else {
      showToast(`✓ Kreirano ${ok} polica`);
    }
    close();
    onSuccess?.();
  });

  /* ── Single save ── */
  overlay.querySelector('#locFormNewShelf').addEventListener('submit', async ev => {
    ev.preventDefault();
    errEl.textContent = '';
    const parent_id = hallSel.value || null;
    const slot = slotInput.value.trim().toUpperCase();
    const desc = descInput.value.trim();
    if (!parent_id) {
      errEl.textContent = 'Izaberi halu.';
      return;
    }
    if (!slot) {
      errEl.textContent = 'Unesi oznaku police (npr. A23).';
      return;
    }
    if (!desc) {
      errEl.textContent = 'Unesi kratak opis police.';
      return;
    }
    const hallCode = hallSel.selectedOptions[0]?.dataset?.code || '';
    /* Finalna šifra: "HALA-SLOT" (konzistentno sa postojećim K-A1..K-S).
     * Ako user već kuca punu šifru (koja sadrži `-`), preskačemo prefiks. */
    const location_code = slot.includes('-') ? slot : hallCode ? `${hallCode}-${slot}` : slot;

    submitBtn.disabled = true;
    const row = await createLocation({
      location_code,
      name: desc,
      location_type: 'SHELF',
      parent_id,
    }).catch(() => null);
    submitBtn.disabled = false;
    if (!row) {
      errEl.textContent = `Snimanje nije uspelo (verovatno već postoji polica "${location_code}").`;
      return;
    }
    showToast(`✓ Polica ${location_code} kreirana`);
    close();
    onSuccess?.();
  });
}

/**
 * Forma za HALU — user unosi šifru (npr. "MAG", "H2") i naziv, uz izbor
 * konkretnog HALA tipa. Parent je null.
 */
function renderHallForm({ overlay, body, close, onSuccess }) {
  const typeOptions = HALL_TYPE_OPTIONS
    .map(o => `<option value="${escHtml(o.value)}">${escHtml(o.label)} (${escHtml(o.value)})</option>`)
    .join('');
  body.innerHTML = `
    <div class="loc-form-breadcrumb">
      <button type="button" class="loc-breadcrumb-back" data-act="back">←</button>
      <span>Nova hala</span>
    </div>

    <div class="kadr-modal-err" id="locModalNewLocErr"></div>
    <form id="locFormNewHall">
      <div class="emp-form-grid">
        <div class="emp-field">
          <label for="locHallCode">Šifra hale *
            <span class="loc-muted" style="font-weight:400;font-size:12px">— kratko, 2-8 slova</span>
          </label>
          <input type="text" id="locHallCode" required maxlength="20" placeholder="npr. MAG, H2, H2A"
                 autocomplete="off" style="text-transform:uppercase" />
        </div>
        <div class="emp-field">
          <label for="locHallName">Naziv hale *</label>
          <input type="text" id="locHallName" required maxlength="200" placeholder="npr. Centralni magacin, Hala 2">
        </div>
        <div class="emp-field col-full">
          <label for="locHallType">Tip hale / zone *</label>
          <select id="locHallType" required>${typeOptions}</select>
          <div class="loc-muted" style="font-size:12px;margin-top:4px">Svi ovi tipovi se u prikazu vode kao HALA; police se definišu unutar njih.</div>
        </div>
      </div>
      <div class="kadr-modal-actions">
        <button type="button" class="btn" data-act="cancel">Otkaži</button>
        <button type="submit" class="btn btn-primary" id="locHallSubmit">Sačuvaj halu</button>
      </div>
    </form>
  `;

  const errEl = overlay.querySelector('#locModalNewLocErr');
  const codeInput = overlay.querySelector('#locHallCode');
  const nameInput = overlay.querySelector('#locHallName');
  const typeSelect = overlay.querySelector('#locHallType');
  const submitBtn = overlay.querySelector('#locHallSubmit');

  overlay.querySelector('[data-act="cancel"]').addEventListener('click', close);
  overlay.querySelector('[data-act="back"]').addEventListener('click', () => {
    /* Vrati na picker — moramo opet da fetch-ujemo da bi lista bila aktuelna. */
    body.innerHTML = '<p class="loc-muted" style="padding:24px 0; text-align:center">Učitavam…</p>';
    fetchLocations({ activeOnly: false }).then(locs => {
      if (Array.isArray(locs)) {
        renderPickerStage({ overlay, body, locs, close, onSuccess });
      } else {
        close();
      }
    });
  });

  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase();
  });

  codeInput.focus();

  overlay.querySelector('#locFormNewHall').addEventListener('submit', async ev => {
    ev.preventDefault();
    errEl.textContent = '';
    const code = codeInput.value.trim().toUpperCase();
    const name = nameInput.value.trim();
    const locationType = String(typeSelect.value || '').toUpperCase();
    if (!code) {
      errEl.textContent = 'Šifra hale je obavezna.';
      return;
    }
    if (!name) {
      errEl.textContent = 'Naziv hale je obavezan.';
      return;
    }
    if (!isHallType(locationType)) {
      errEl.textContent = 'Izaberi validan tip hale.';
      return;
    }
    submitBtn.disabled = true;
    const row = await createLocation({
      location_code: code,
      name,
      location_type: locationType,
      parent_id: null,
    }).catch(() => null);
    submitBtn.disabled = false;
    if (!row) {
      errEl.textContent = `Snimanje nije uspelo (verovatno već postoji hala "${code}").`;
      return;
    }
    showToast(`✓ Hala ${code} kreirana`);
    close();
    onSuccess?.();
  });
}

/**
 * Edit forma — ažurira samo naziv / opis. Šifra i tip se ne menjaju jer
 * se koriste u sync-u sa ERP-om i u `loc_item_placements` indeksima.
 */
function renderEditForm({ overlay, body, existing, close, onSuccess }) {
  const type = String(existing.location_type || '').toUpperCase();
  const kind = getLocationKindLabel(type);
  const kindLabel = `${kind} · ${getLocationTypeLabel(type)} (${type || '—'})`;
  const parentHint = isShelfType(type)
    ? 'Polica je konkretno mesto unutar hale. Promena hale/tipa se radi kontrolisano kroz bazu zbog istorije i postojećih placement-a.'
    : isHallType(type)
      ? 'Hala je root lokacija; police se vezuju na nju kroz parent odnos.'
      : 'Specijalna lokacija van osnovne podele HALA/POLICA.';

  const isActive = existing.is_active !== false;
  /* Dugme za deaktivaciju mora biti dovoljno uočljivo da admin primeti da je
   * to DESTRUCTIVE action (skriva lokaciju iz svih dropdown-a), ali skriveno
   * ispod linije da ne bi slučajno kliknuo umesto "Sačuvaj". Aktiviraj je
   * suprotan toggle. */
  const toggleLabel = isActive ? '🗑 Deaktiviraj ovu lokaciju' : '✅ Aktiviraj ponovo';
  const toggleHint = isActive
    ? 'Posle deaktivacije lokacija neće biti vidljiva u "Na lokaciju" select-u, ali ostaje u bazi radi istorije.'
    : 'Lokacija je trenutno deaktivirana — kad je aktiviraš ponovo biće ponuđena u "Na lokaciju" select-u.';

  body.innerHTML = `
    <div class="loc-form-breadcrumb">
      <span>${kindLabel}</span>
      <strong class="loc-path-muted">· ${escHtml(existing.location_code || '')}</strong>
      ${isActive ? '' : '<span class="loc-badge loc-badge-inactive">neaktivno</span>'}
    </div>

    <div class="kadr-modal-err" id="locModalNewLocErr"></div>
    <form id="locFormEditLoc">
      <div class="emp-form-grid">
        <div class="emp-field col-full">
          <label>Poslovni tip</label>
          <div class="loc-readonly-field">${escHtml(kindLabel)}</div>
          <div class="loc-muted" style="font-size:12px;margin-top:4px">${escHtml(parentHint)}</div>
        </div>
        <div class="emp-field col-full">
          <label for="locEditName">Naziv / opis *</label>
          <input type="text" id="locEditName" required maxlength="200" value="${escHtml(existing.name || '')}">
        </div>
        <div class="emp-field">
          <label for="locEditCapacity">Kapacitet / napomena kapaciteta</label>
          <input type="text" id="locEditCapacity" maxlength="200" value="${escHtml(existing.capacity_note || '')}" placeholder="npr. max 20 kom, paletna pozicija">
        </div>
        <div class="emp-field">
          <label for="locEditNotes">Interna napomena</label>
          <input type="text" id="locEditNotes" maxlength="500" value="${escHtml(existing.notes || '')}" placeholder="npr. privremeno, samo inox, zona prijema">
        </div>
      </div>
      <div class="kadr-modal-actions">
        <button type="button" class="btn" data-act="cancel">Otkaži</button>
        <button type="submit" class="btn btn-primary" id="locEditSubmit">Sačuvaj</button>
      </div>
    </form>

    <div class="loc-edit-danger">
      <div class="loc-edit-danger-hint">${escHtml(toggleHint)}</div>
      <button type="button" class="btn ${isActive ? 'btn-danger-soft' : 'btn-success-soft'}"
              id="locEditToggle" data-next-active="${isActive ? 'false' : 'true'}">
        ${toggleLabel}
      </button>
    </div>
  `;

  const errEl = overlay.querySelector('#locModalNewLocErr');
  const nameInput = overlay.querySelector('#locEditName');
  const capacityInput = overlay.querySelector('#locEditCapacity');
  const notesInput = overlay.querySelector('#locEditNotes');
  const submitBtn = overlay.querySelector('#locEditSubmit');
  const toggleBtn = overlay.querySelector('#locEditToggle');

  overlay.querySelector('[data-act="cancel"]').addEventListener('click', close);
  nameInput.focus();

  overlay.querySelector('#locFormEditLoc').addEventListener('submit', async ev => {
    ev.preventDefault();
    errEl.textContent = '';
    const name = nameInput.value.trim();
    if (!name) {
      errEl.textContent = 'Naziv je obavezan.';
      return;
    }
    submitBtn.disabled = true;
    const row = await updateLocation(existing.id, {
      name,
      capacity_note: capacityInput.value.trim() || null,
      notes: notesInput.value.trim() || null,
    });
    submitBtn.disabled = false;
    if (!row) {
      errEl.textContent = 'Izmena nije uspela (možda nemaš permisije).';
      return;
    }
    showToast('✓ Izmene snimljene');
    close();
    onSuccess?.();
  });

  toggleBtn.addEventListener('click', async () => {
    const nextActive = toggleBtn.getAttribute('data-next-active') === 'true';
    const confirmMsg = nextActive
      ? `Aktiviraj lokaciju "${existing.location_code}"?`
      : `Deaktiviraj lokaciju "${existing.location_code}"?\nBiće sakrivena iz select-a, ali istorija ostaje.`;
    if (!window.confirm(confirmMsg)) return;
    errEl.textContent = '';
    toggleBtn.disabled = true;
    const row = await updateLocation(existing.id, { is_active: nextActive });
    toggleBtn.disabled = false;
    if (!row) {
      errEl.textContent = 'Promena statusa nije uspela (možda nemaš permisije).';
      return;
    }
    showToast(nextActive ? '✓ Lokacija aktivirana' : '✓ Lokacija deaktivirana');
    close();
    onSuccess?.();
  });
}

/* Wrapper — zadržava staro ime radi kompatibilnosti sa postojećim pozivima. */
export function openNewLocationModal(opts = {}) {
  return openLocationModal({ existing: null, ...opts });
}

/**
 * Modal sa istorijom premeštanja za jednu stavku.
 * Ako je `orderNo` prosleđen (string, uklj. `''`), istorija je scope-ovana samo
 * na taj nalog. `undefined` → vraća istoriju za sve naloge tog crteža.
 * @param {{ itemRefTable: string, itemRefId: string, orderNo?: string }} params
 */
export function openItemHistoryModal({ itemRefTable, itemRefId, orderNo = undefined }) {
  if (!itemRefTable || !itemRefId) {
    showToast('⚠ Nedostaje referenca stavke');
    return;
  }

  const modalId = 'locModalHistory';
  const scopeHint = typeof orderNo === 'string'
    ? ` · nalog <code>${escHtml(orderNo || '(bez naloga)')}</code>`
    : ' · svi nalozi';
  const { overlay, body } = createModalShell({
    id: modalId,
    title: 'Istorija premeštanja',
    subtitle: `<code>${escHtml(itemRefTable)}</code> · <code>${escHtml(itemRefId)}</code>${scopeHint}`,
  });

  let unbindEsc = null;
  const close = () => {
    if (unbindEsc) {
      unbindEsc();
      unbindEsc = null;
    }
    removeModal(modalId);
  };
  unbindEsc = bindEscClose(close);
  overlay.addEventListener('click', ev => {
    if (ev.target === overlay) close();
  });

  (async () => {
    const [movs, locs] = await Promise.all([
      fetchItemMovements(itemRefTable, itemRefId, 200, orderNo),
      fetchLocations({ activeOnly: false }),
    ]);

    if (!Array.isArray(movs)) {
      body.innerHTML = `<p class="loc-warn">Učitavanje istorije neuspešno.</p>
        <div class="kadr-modal-actions"><button type="button" class="btn" id="locHistClose">Zatvori</button></div>`;
      overlay.querySelector('#locHistClose').addEventListener('click', close);
      return;
    }

    const locIdx = new Map(
      Array.isArray(locs) ? locs.filter(l => l?.id).map(l => [l.id, l]) : [],
    );
    const locBrief = id => {
      if (!id) return '<span class="loc-muted">—</span>';
      const l = locIdx.get(id);
      return l
        ? `<span class="loc-code-strong">${escHtml(l.location_code || '')}</span> · ${escHtml(l.name || '')}`
        : `<span class="loc-path">${escHtml(String(id).slice(0, 8))}…</span>`;
    };

    const rowsHtml = movs.length
      ? movs
          .map(m => {
            const ts = (m.moved_at || '').replace('T', ' ').slice(0, 16);
            const qty = m.quantity == null ? '' : escHtml(String(m.quantity));
            const ord = m.order_no
              ? `<strong>${escHtml(m.order_no)}</strong>`
              : '<span class="loc-muted">—</span>';
            return `<tr>
              <td class="loc-path">${escHtml(ts)}</td>
              <td>${ord}</td>
              <td><span class="loc-mov-type">${escHtml(m.movement_type || '')}</span></td>
              <td class="loc-qty-cell">${qty}</td>
              <td>${locBrief(m.from_location_id)}</td>
              <td>${locBrief(m.to_location_id)}</td>
              <td class="loc-path">${escHtml((m.note || m.movement_reason || '').slice(0, 120))}</td>
            </tr>`;
          })
          .join('')
      : '<tr><td colspan="7" class="loc-muted">Nema zabeleženih premeštanja.</td></tr>';

    body.innerHTML = `
      <div class="loc-table-wrap" style="max-height:60vh">
        <table class="loc-table">
          <thead><tr><th>Vreme</th><th>Nalog</th><th>Tip</th><th class="loc-qty-cell">Količina</th><th>Odakle</th><th>Dokle</th><th>Napomena</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      <div class="kadr-modal-actions">
        <button type="button" class="btn" id="locHistClose">Zatvori</button>
      </div>`;

    overlay.querySelector('#locHistClose').addEventListener('click', close);
  })();
}

/**
 * Toggle `is_active` na postojećoj lokaciji (RLS: admin / leadpm / pm).
 * @param {object} row lokacija koju menjamo
 * @param {{ onSuccess?: () => void }} [opts]
 */
export async function toggleLocationActive(row, { onSuccess } = {}) {
  if (!canEdit()) {
    showToast('⚠ Samo admin / LeadPM / PM / Menadžment može da (de)aktivira lokacije');
    return;
  }
  const next = !row.is_active;
  const verb = next ? 'aktivirati' : 'deaktivirati';
  const msg = `Da li želiš da ${verb} lokaciju "${row.location_code} — ${row.name}"?`;
  if (!window.confirm(msg)) return;

  const updated = await updateLocation(row.id, { is_active: next });
  if (!updated) {
    showToast('⚠ Izmena statusa nije uspela');
    return;
  }
  showToast(next ? '✓ Lokacija aktivirana' : '✓ Lokacija deaktivirana');
  onSuccess?.();
}

/**
 * @param {{ onSuccess?: () => void }} [opts]
 */
export function openQuickMoveModal({ onSuccess } = {}) {
  const modalId = 'locModalQuickMove';
  const { overlay, body } = createModalShell({
    id: modalId,
    title: 'Brzo premeštanje',
    subtitle:
      'Unesi broj predmeta i TP; broj crteža se puni iz BigTehn keša. Za novu stavku <strong>INITIAL_PLACEMENT</strong>; za postojeći placement <strong>TRANSFER</strong> ili drugi tip.',
  });

  let unbindEsc = null;
  const close = () => {
    if (unbindEsc) {
      unbindEsc();
      unbindEsc = null;
    }
    removeModal(modalId);
  };
  unbindEsc = bindEscClose(close);
  overlay.addEventListener('click', ev => {
    if (ev.target === overlay) close();
  });

  (async () => {
    const locs = await fetchLocations();
    if (!Array.isArray(locs)) {
      close();
      showToast('⚠ Ne mogu da učitam lokacije');
      return;
    }

    /* Prva upotreba — nema nijedne master lokacije. Nema smisla prikazati
     * prazan select; usmeri korisnika na "Nova lokacija". */
    if (locs.length === 0) {
      body.innerHTML = `
        <div class="kadr-modal-empty" style="padding:16px 8px;text-align:center">
          <p style="font-size:14px;color:var(--text2);margin:0 0 12px">
            Nema definisanih master lokacija.<br>
            Prvo dodaj bar jednu lokaciju preko <strong>Nova lokacija</strong>,
            pa se vrati ovde.
          </p>
          <button type="button" class="btn btn-primary" id="locQmGotoNew">Nova lokacija</button>
          <button type="button" class="btn" id="locQmCloseEmpty" style="margin-left:8px">Zatvori</button>
        </div>`;
      overlay.querySelector('#locQmCloseEmpty').addEventListener('click', close);
      overlay.querySelector('#locQmGotoNew').addEventListener('click', () => {
        close();
        openNewLocationModal({ onSuccess });
      });
      return;
    }

    const toOpts = locationOptionsHtml(locs, {
      includeBlank: true,
      blankLabel: '— izaberi odredište —',
    });
    const movOpts = MOVEMENT_TYPES.map(t => `<option value="${t}">${escHtml(t)}</option>`).join('');

    /* Index lokacija po UUID-u — za brzi lookup labele u "trenutno na..." pregledu. */
    const locById = new Map(locs.map(l => [l.id, l]));

    body.innerHTML = `
      <div class="kadr-modal-err" id="locModalQuickMoveErr"></div>
      <form id="locFormQuickMove" novalidate>
        <div class="emp-form-grid">
          <div class="emp-field">
            <label for="locQmOrder">Broj predmeta *</label>
            <input type="text" id="locQmOrder" required maxlength="40" placeholder="npr. 7351 ili 9400-1" autocomplete="off">
          </div>
          <div class="emp-field">
            <label for="locQmTp">Broj TP * <span class="loc-muted" style="font-weight:400">(lista iz keša za predmet)</span></label>
            <input type="text" id="locQmTp" required maxlength="40" list="locQmTpDatalist" placeholder="npr. 1088" autocomplete="off">
            <datalist id="locQmTpDatalist"></datalist>
          </div>
          <div class="emp-field">
            <label for="locQmDrawing">Broj crteža</label>
            <input type="text" id="locQmDrawing" readonly tabindex="-1" maxlength="80" placeholder="— automatski —" autocomplete="off" style="background:var(--surface2);cursor:default">
          </div>

          <div class="emp-field col-full" id="locQmStateWrap" hidden>
            <div class="loc-current-state" id="locQmState"></div>
          </div>

          <div class="emp-field">
            <label for="locQmType">Tip pokreta *</label>
            <select id="locQmType" required>${movOpts}</select>
          </div>
          <div class="emp-field">
            <label for="locQmQty">Količina *</label>
            <input type="number" id="locQmQty" required min="0.001" step="0.001" value="1">
          </div>

          <div class="emp-field col-full" id="locQmFromWrap" hidden>
            <label for="locQmFrom">Sa lokacije *</label>
            <select id="locQmFrom"></select>
            <div class="loc-muted" id="locQmFromHint" style="font-size:11px;margin-top:4px"></div>
          </div>

          <div class="emp-field col-full">
            <label for="locQmTo">Odredišna lokacija *</label>
            <select id="locQmTo" required>${toOpts}</select>
          </div>

          <div class="emp-field col-full">
            <label for="locQmNote">Napomena</label>
            <textarea id="locQmNote" maxlength="500" rows="2" placeholder="Opciono"></textarea>
          </div>
        </div>
        <div class="kadr-modal-actions">
          <button type="button" class="btn" id="locQmCancel">Otkaži</button>
          <button type="submit" class="btn btn-primary" id="locQmSubmit">Izvrši</button>
        </div>
      </form>`;

    const errEl = overlay.querySelector('#locModalQuickMoveErr');
    /** Jasna povratna informacija: tekst u modalu + toast + konzola. */
    const qmShowErr = msg => {
      const t = String(msg || '').trim() || 'Nepoznata greška.';
      errEl.textContent = t;
      showToast(`⚠ ${t}`);
      console.warn('[quickMove]', t);
      try {
        errEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } catch (_) {
        /* ignore */
      }
    };
    const submitBtn = overlay.querySelector('#locQmSubmit');
    const orderInput = overlay.querySelector('#locQmOrder');
    const tpInput = overlay.querySelector('#locQmTp');
    const drawingInput = overlay.querySelector('#locQmDrawing');
    const tpDatalist = overlay.querySelector('#locQmTpDatalist');
    const typeSel = overlay.querySelector('#locQmType');
    const qtyInput = overlay.querySelector('#locQmQty');
    const fromWrap = overlay.querySelector('#locQmFromWrap');
    const fromSel = overlay.querySelector('#locQmFrom');
    const fromHint = overlay.querySelector('#locQmFromHint');
    const stateWrap = overlay.querySelector('#locQmStateWrap');
    const stateEl = overlay.querySelector('#locQmState');

    /* Stanje: trenutni placement-i za (bigtehn_rn, TP, predmet) — mapa location_id → qty. */
    let currentPlacements = [];
    let lookupToken = 0;
    let tpListToken = 0;
    let drawingLookupToken = 0;

    function refreshFromHint() {
      const locId = fromSel.value;
      const row = currentPlacements.find(r => r.location_id === locId);
      if (row) {
        fromHint.textContent = `Trenutno na izabranoj polaznoj lokaciji: ${row.quantity} kom.`;
        qtyInput.max = row.quantity;
        const maxQ = Number(row.quantity);
        const cur = Number(qtyInput.value);
        if (Number.isFinite(maxQ) && maxQ > 0 && Number.isFinite(cur) && cur > maxQ) {
          qtyInput.value = String(maxQ);
        }
      } else {
        fromHint.textContent = '';
        qtyInput.removeAttribute('max');
      }
    }

    function applyTypeMode() {
      const t = typeSel.value;
      const needsFrom = t !== 'INITIAL_PLACEMENT' && t !== 'INVENTORY_ADJUSTMENT';
      fromWrap.hidden = !needsFrom;
      fromSel.required = needsFrom;
      refreshFromHint();
    }

    function renderState(rows, { scoped }) {
      currentPlacements = Array.isArray(rows) ? rows.filter(r => Number(r.quantity) > 0) : [];
      if (!currentPlacements.length) {
        stateWrap.hidden = true;
        stateEl.innerHTML = '';
        fromSel.innerHTML = '<option value="">— nema zabeleženog smeštaja za predmet/TP —</option>';
        /* Nove stavke default-uju na INITIAL_PLACEMENT. */
        if (tpInput.value.trim()) typeSel.value = 'INITIAL_PLACEMENT';
        applyTypeMode();
        return;
      }

      /* Kada nalog nije sužen, prikazujemo sve bucket-e; klik na chip popuni predmet. */
      const chips = currentPlacements.map(r => {
        const loc = locById.get(r.location_id);
        const locLbl = loc ? `${loc.location_code} — ${loc.name}` : r.location_id;
        const orderPart = r.order_no ? `<strong>${escHtml(r.order_no)}</strong> · ` : '';
        const clickable = !scoped && r.order_no;
        const extra = clickable ? ` loc-chip-click" data-qm-order="${escHtml(r.order_no)}` : '';
        return `<span class="loc-chip${extra}">${orderPart}${escHtml(locLbl)} · <strong>${escHtml(String(r.quantity))}</strong></span>`;
      }).join('');
      const total = currentPlacements.reduce((a, r) => a + Number(r.quantity || 0), 0);
      const title = scoped
        ? `Trenutno smešteno za predmet ${escHtml(orderInput.value.trim())} / TP ${escHtml(tpInput.value.trim())} (ukupno ${escHtml(String(total))} kom.):`
        : `Placement-i za ovaj TP na drugim predmetima (ukupno ${escHtml(String(total))} kom.) — klik na predmet ga upisuje:`;
      stateEl.innerHTML = `
        <div class="loc-current-title">${title}</div>
        <div class="loc-chip-row">${chips}</div>`;
      stateWrap.hidden = false;

      /* From dropdown ima smisla samo kada znamo nalog — inače ne možemo
       * striktno da oduzmemo iz bucketa. */
      if (!scoped) {
        fromSel.innerHTML = '<option value="">— prvo unesi broj predmeta —</option>';
      } else {
        fromSel.innerHTML =
          '<option value="">— izaberi polaznu —</option>' +
          currentPlacements.map(r => {
            const loc = locById.get(r.location_id);
            const label = loc ? `${loc.location_code} — ${loc.name}` : r.location_id;
            return `<option value="${escHtml(r.location_id)}">${escHtml(label)} (${escHtml(String(r.quantity))} kom.)</option>`;
          }).join('');
      }

      /* Default: TRANSFER (ako je već negde) — korisnik tipično prebacuje. */
      if (typeSel.value === 'INITIAL_PLACEMENT') typeSel.value = 'TRANSFER';
      applyTypeMode();
    }

    async function refreshItemState() {
      const order = orderInput.value.trim();
      const tp = tpInput.value.trim();
      const myToken = ++lookupToken;
      if (!tp) {
        renderState([], { scoped: false });
        return;
      }
      const rows = await fetchItemPlacements(
        LOC_QM_ITEM_REF_TABLE,
        tp,
        order ? order : undefined,
      );
      if (myToken !== lookupToken) return;
      renderState(rows || [], { scoped: !!order });
    }

    async function refreshTpDatalist() {
      const order = orderInput.value.trim();
      const my = ++tpListToken;
      if (!order) {
        tpDatalist.innerHTML = '';
        return;
      }
      if (!getIsOnline()) {
        tpDatalist.innerHTML = '';
        return;
      }
      const opts = await fetchTpOptionsForPredmetOrder(order);
      if (my !== tpListToken) return;
      tpDatalist.innerHTML = (opts || [])
        .map(
          o =>
            `<option value="${escHtml(o.tp)}">${escHtml(o.tp)}${o.broj_crteza ? ` — crtež ${escHtml(o.broj_crteza)}` : ''}</option>`,
        )
        .join('');
    }

    async function refreshDrawingFromErp() {
      const order = orderInput.value.trim();
      const tp = tpInput.value.trim();
      const my = ++drawingLookupToken;
      if (!order || !tp) {
        drawingInput.value = '';
        return;
      }
      const cached = qmGetDrawingCache(order, tp);
      if (!getIsOnline()) {
        drawingInput.value = cached || '';
        return;
      }
      let snap = null;
      try {
        snap = await fetchBigtehnOpSnapshotByRnAndTp(order, tp);
      } catch (e) {
        console.warn('[quickMove] ERP snapshot failed', e);
      }
      if (my !== drawingLookupToken) return;
      const erp = snap?.broj_crteza ? String(snap.broj_crteza).trim() : '';
      drawingInput.value = (erp || cached || '').trim();
    }

    /* Debounce da ne zovemo za svaki keypress. */
    let debounceT = null;
    const scheduleRefresh = () => {
      clearTimeout(debounceT);
      debounceT = setTimeout(refreshItemState, 300);
    };
    let debounceTpList = null;
    const scheduleTpList = () => {
      clearTimeout(debounceTpList);
      debounceTpList = setTimeout(refreshTpDatalist, 400);
    };
    let debounceDraw = null;
    const scheduleDrawing = () => {
      clearTimeout(debounceDraw);
      debounceDraw = setTimeout(refreshDrawingFromErp, 280);
    };

    orderInput.addEventListener('input', () => {
      scheduleRefresh();
      scheduleTpList();
      scheduleDrawing();
    });
    orderInput.addEventListener('blur', () => {
      refreshItemState();
      refreshTpDatalist();
      refreshDrawingFromErp();
    });
    tpInput.addEventListener('input', () => {
      scheduleRefresh();
      scheduleDrawing();
    });
    tpInput.addEventListener('blur', () => {
      refreshItemState();
      refreshDrawingFromErp();
    });
    typeSel.addEventListener('change', applyTypeMode);
    fromSel.addEventListener('change', refreshFromHint);

    /* Klik na chip sa predmetom u "svi nalozi" prikazu → popuni predmet. */
    stateEl.addEventListener('click', ev => {
      const chipOrder = ev.target.closest?.('[data-qm-order]')?.getAttribute('data-qm-order');
      if (!chipOrder) return;
      orderInput.value = chipOrder;
      refreshItemState();
      refreshTpDatalist();
      refreshDrawingFromErp();
    });

    overlay.querySelector('#locQmCancel').addEventListener('click', close);
    orderInput.focus();
    applyTypeMode();

    overlay.querySelector('#locFormQuickMove').addEventListener('submit', async ev => {
      ev.preventDefault();
      errEl.textContent = '';
      const item_ref_table = LOC_QM_ITEM_REF_TABLE;
      const item_ref_id = tpInput.value.trim();
      const order_no = orderInput.value.trim();
      const drawing_no = drawingInput.value.trim();
      const to_location_id = overlay.querySelector('#locQmTo').value;
      const movement_type = typeSel.value;
      const note = overlay.querySelector('#locQmNote').value.trim();
      const qty = Number(qtyInput.value);
      const needsFrom = movement_type !== 'INITIAL_PLACEMENT' && movement_type !== 'INVENTORY_ADJUSTMENT';
      const from_location_id = needsFrom ? String(fromSel.value || '').trim() : '';

      if (!order_no || !item_ref_id || !to_location_id || !movement_type) {
        qmShowErr('Popuni obavezna polja: broj predmeta, broj TP i odredišna lokacija.');
        return;
      }
      if (!Number.isFinite(qty) || qty <= 0) {
        qmShowErr('Količina mora biti veća od 0.');
        return;
      }
      if (needsFrom) {
        if (!currentPlacements.length) {
          qmShowErr(
            'Za izabrani tip pokreta mora postojati zabeležen smeštaj u Lokacijama (predmet + TP). ' +
              'Nema smeštaja — koristi INITIAL_PLACEMENT za prvi unos, ili proveri predmet i TP.',
          );
          return;
        }
        if (!from_location_id) {
          qmShowErr(
            'Polje „Sa lokacije“ je obavezno: izaberi lokaciju sa koje premeštaš (ili prebaci tip na INITIAL_PLACEMENT ako je prvi smeštaj).',
          );
          return;
        }
        const fromRow = currentPlacements.find(r => r.location_id === from_location_id);
        if (!fromRow) {
          qmShowErr(
            'Polazna lokacija ne odgovara učitanom stanju. Sačekaj učitavanje ili ponovo izaberi „Sa lokacije“.',
          );
          return;
        }
        if (from_location_id === to_location_id) {
          qmShowErr('Polazna i odredišna lokacija moraju biti različite.');
          return;
        }
        const maxQ = Number(fromRow.quantity);
        if (Number.isFinite(maxQ) && qty > maxQ) {
          qmShowErr(`Količina ne sme biti veća od ${maxQ} kom. na izabranoj polaznoj lokaciji.`);
          return;
        }
      }

      const noteParts = [];
      if (note) noteParts.push(note);
      if (drawing_no) noteParts.push(`Crtež:${drawing_no}`);
      const noteCombined = noteParts.length ? noteParts.join(' | ') : undefined;

      submitBtn.disabled = true;
      try {
        const res = await locCreateMovement({
          item_ref_table,
          item_ref_id,
          order_no,
          drawing_no: drawing_no || undefined,
          to_location_id,
          from_location_id: from_location_id || undefined,
          movement_type,
          quantity: qty,
          note: noteCombined,
        });
        if (!res) {
          qmShowErr('Server nije odgovorio (mreža ili sesija). Proveri konekciju i prijavu.');
          return;
        }
        if (!res.ok) {
          const human = movementErrMsg(res.error, res);
          console.warn('[quickMove] loc_create_movement', res.error, res);
          qmShowErr(human);
          return;
        }
        if (drawing_no && order_no && item_ref_id) {
          qmSetDrawingCache(order_no, item_ref_id, drawing_no);
        }
        showToast('✓ Premeštanje zabeleženo');
        close();
        onSuccess?.();
      } catch (e) {
        console.error('[quickMove] submit', e);
        const em = e && typeof e.message === 'string' && e.message.trim() ? e.message.trim() : 'Neočekivana greška pri slanju.';
        qmShowErr(em);
      } finally {
        submitBtn.disabled = false;
      }
    });
  })();
}
