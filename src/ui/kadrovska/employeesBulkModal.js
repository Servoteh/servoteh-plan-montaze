/**
 * Kadrovska — Brzi/bulk unos zaposlenih.
 *
 * Dva moda u jednom modalu (tabovi):
 *   1) "Brzi unos" — inline tabela u kojoj se unosi red-po-red.
 *      Tab/Enter navigacija, auto-dodavanje novog reda posle poslednjeg,
 *      live validacija, bulk INSERT na kraju.
 *   2) "Import iz Excel/CSV" — drag&drop ili file picker; parse preko SheetJS
 *      (CDN lazy load), mapiranje kolona, preview sa validacijom,
 *      bulk INSERT potvrđenih redova.
 *
 * Podržana polja u oba moda (admin dodatno vidi osetljiva):
 *   firstName, lastName, position, department, team, hireDate,
 *   email, phoneWork, isActive,
 *   + (admin): personalId (JMBG), gender, birthDate,
 *                 address, city, postalCode,
 *                 bankName, bankAccount
 *
 * JMBG → auto-fill gender + birthDate ako ih korisnik nije uneo.
 *
 * Public API:
 *   openEmployeesBulkModal({ onSaved })  — otvara modal
 *   downloadEmployeesTemplate()          — generiše i download-uje Excel template
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { canViewEmployeePii } from '../../state/auth.js';
import { loadXlsx } from '../../lib/xlsx.js';
import { saveEmployeeToDb } from '../../services/employees.js';

/* ─── KOLONE ─────────────────────────────────────────────────────────── */

/**
 * Definicija kolona za brzi unos / import. `sensitive: true` kolone vide
 * samo admin; za ostale se preskaču i u gridu i u template-u.
 *
 * `aliases` — sinonimi iz Excel header-a (case-insensitive, trim-ovano,
 * bez dijakritika) koje mapiramo na ovu kolonu prilikom importa.
 */
const COLUMNS = [
  { key: 'firstName',   label: 'Ime',                type: 'text',   width: 130, required: true,
    aliases: ['ime', 'firstname', 'first name'] },
  { key: 'lastName',    label: 'Prezime',            type: 'text',   width: 140, required: true,
    aliases: ['prezime', 'lastname', 'last name', 'surname'] },
  { key: 'position',    label: 'Pozicija',           type: 'text',   width: 150,
    aliases: ['pozicija', 'position', 'radno mesto'] },
  { key: 'department',  label: 'Odeljenje',          type: 'text',   width: 140,
    aliases: ['odeljenje', 'department', 'sektor'] },
  { key: 'team',        label: 'Tim',                type: 'text',   width: 110,
    aliases: ['tim', 'team'] },
  { key: 'hireDate',    label: 'Zaposlen od',        type: 'date',   width: 130, required: true,
    aliases: ['zaposlen od', 'hire date', 'datum zaposlenja', 'hiredate'] },
  { key: 'email',       label: 'Email',              type: 'email',  width: 180,
    aliases: ['email', 'e-mail', 'mail'] },
  { key: 'phoneWork',   label: 'Telefon (posao)',    type: 'tel',    width: 130,
    aliases: ['telefon', 'telefon posao', 'phone', 'phone work', 'tel'] },
  { key: 'isActive',    label: 'Aktivan',            type: 'bool',   width: 80,  default: true,
    aliases: ['aktivan', 'active', 'status'] },
  { key: 'personalId',  label: 'JMBG',               type: 'jmbg',   width: 140, sensitive: true,
    aliases: ['jmbg', 'personal id', 'pib'] },
  { key: 'gender',      label: 'Pol (M/Z)',          type: 'gender', width: 80,  sensitive: true,
    aliases: ['pol', 'gender'] },
  { key: 'birthDate',   label: 'Datum rođenja',      type: 'date',   width: 130, sensitive: true,
    aliases: ['datum rodjenja', 'datum rođenja', 'birth date', 'birthdate'] },
  { key: 'address',     label: 'Adresa',             type: 'text',   width: 180, sensitive: true,
    aliases: ['adresa', 'address'] },
  { key: 'city',        label: 'Mesto',              type: 'text',   width: 130, sensitive: true,
    aliases: ['mesto', 'grad', 'city'] },
  { key: 'postalCode',  label: 'Poštanski br.',      type: 'text',   width: 100, sensitive: true,
    aliases: ['postanski', 'poštanski', 'postal code', 'zip'] },
  { key: 'bankName',    label: 'Banka',              type: 'text',   width: 140, sensitive: true,
    aliases: ['banka', 'bank', 'bank name'] },
  { key: 'bankAccount', label: 'Broj računa',        type: 'text',   width: 160, sensitive: true,
    aliases: ['broj racuna', 'broj računa', 'racun', 'bank account', 'iban'] },
];

function activeColumns() {
  const showSensitive = canViewEmployeePii();
  return COLUMNS.filter(c => showSensitive || !c.sensitive);
}

/* ─── VALIDATORI ─────────────────────────────────────────────────────── */

/** Vrati niz error poruka za jedan red (prazan niz = validan). */
function validateRow(row) {
  const errs = [];
  const cols = activeColumns();
  for (const c of cols) {
    const v = row[c.key];
    if (c.required && !v) {
      errs.push(`${c.label} je obavezno`);
      continue;
    }
    if (!v) continue;
    if (c.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      errs.push(`${c.label}: očekujem YYYY-MM-DD`);
    }
    if (c.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
      errs.push(`${c.label}: neispravan email`);
    }
    if (c.type === 'jmbg' && !/^\d{13}$/.test(v)) {
      errs.push(`${c.label}: mora imati 13 cifara`);
    }
    if (c.type === 'gender' && !/^(M|Z)$/i.test(v)) {
      errs.push(`${c.label}: M ili Z`);
    }
  }
  return errs;
}

function parseJmbgToDobGender(jmbg) {
  if (!jmbg || !/^\d{13}$/.test(jmbg)) return null;
  const dd = +jmbg.slice(0, 2);
  const mm = +jmbg.slice(2, 4);
  const yyy = +jmbg.slice(4, 7);
  const rrr = +jmbg.slice(9, 12);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const year = yyy >= 900 ? 1000 + yyy : 2000 + yyy;
  return {
    birthDate: `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`,
    gender: rrr >= 500 ? 'Z' : 'M',
  };
}

/** Normalizacija Excel date vrednosti u ISO YYYY-MM-DD. */
function normalizeDate(val) {
  if (!val && val !== 0) return '';
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  if (typeof val === 'number') {
    /* Excel serial date (days since 1899-12-30). */
    const ms = Math.round((val - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  /* DD.MM.YYYY ili DD/MM/YYYY */
  const m = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})$/);
  if (m) {
    let y = +m[3];
    if (y < 100) y += y < 50 ? 2000 : 1900;
    return `${y}-${String(+m[2]).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
  }
  return s;
}

function normalizeBool(val) {
  if (val === true || val === false) return val;
  const s = String(val ?? '').trim().toLowerCase();
  if (['1', 'true', 'da', 'yes', 'y', 'aktivan'].includes(s)) return true;
  if (['0', 'false', 'ne', 'no', 'n', 'neaktivan'].includes(s)) return false;
  return true;
}

function normHeader(h) {
  return String(h || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

/* ─── MODAL STATE ────────────────────────────────────────────────────── */

let modalEl = null;
let activeMode = 'grid';   // 'grid' | 'import'
let gridRows = [];         // Brzi unos redovi
let importRows = [];       // Import preview redovi (posle parsiranja)
let onSavedCb = null;

function makeEmptyRow() {
  const r = {};
  activeColumns().forEach(c => {
    r[c.key] = c.default !== undefined ? c.default : '';
  });
  return r;
}

/* ─── MODAL HTML ─────────────────────────────────────────────────────── */

function modalHtml() {
  return `
    <div class="pm-modal-backdrop" id="empBulkBackdrop"></div>
    <div class="pm-modal pm-modal-xl" id="empBulkModal" role="dialog" aria-labelledby="empBulkTitle" aria-modal="true">
      <header class="pm-modal-header">
        <h2 id="empBulkTitle">Brzi / bulk unos zaposlenih</h2>
        <button class="pm-modal-close" id="empBulkClose" aria-label="Zatvori">✕</button>
      </header>
      <div class="pm-modal-tabs" role="tablist">
        <button class="pm-modal-tab active" data-bulk-mode="grid" role="tab" aria-selected="true">⚡ Brzi unos</button>
        <button class="pm-modal-tab" data-bulk-mode="import" role="tab" aria-selected="false">📥 Import iz Excel/CSV</button>
        <div class="pm-modal-tabs-spacer"></div>
        <button class="btn btn-ghost btn-sm" id="empBulkTemplateBtn" title="Preuzmi Excel template">📄 Template</button>
      </div>
      <div class="pm-modal-body" id="empBulkBody"></div>
      <footer class="pm-modal-footer" id="empBulkFooter"></footer>
    </div>
  `;
}

/* ─── GRID MODE ──────────────────────────────────────────────────────── */

function renderGridMode() {
  const cols = activeColumns();
  const head = `<tr>
    <th class="bulk-idx">#</th>
    ${cols.map(c => `<th style="min-width:${c.width || 120}px">${escHtml(c.label)}${c.required ? ' *' : ''}</th>`).join('')}
    <th class="bulk-err">Status</th>
    <th></th>
  </tr>`;

  const body = gridRows.map((r, i) => rowTr(r, i)).join('');

  return `
    <div class="emp-bulk-info">
      <small>Tab/Enter za sledeće polje. Novi red se dodaje automatski. Posle JMBG-a auto-popunjavaju se pol i datum rođenja.</small>
    </div>
    <div class="emp-bulk-grid-wrap">
      <table class="emp-bulk-grid" id="empBulkGrid">
        <thead>${head}</thead>
        <tbody id="empBulkGridBody">${body}</tbody>
      </table>
    </div>
    <div class="emp-bulk-actions">
      <button class="btn btn-ghost" id="empBulkAddRowBtn" type="button">+ Dodaj red</button>
      <button class="btn btn-ghost" id="empBulkClearBtn" type="button">Obriši sve</button>
    </div>
  `;
}

function rowTr(r, i) {
  const cols = activeColumns();
  const errs = validateRow(r);
  const isEmpty = cols.every(c => !r[c.key] || (c.type === 'bool' && r[c.key] === (c.default ?? false)));
  const statusCell = isEmpty
    ? '<span class="emp-bulk-status muted">prazno</span>'
    : (errs.length === 0
        ? '<span class="emp-bulk-status ok">OK</span>'
        : `<span class="emp-bulk-status err" title="${escHtml(errs.join('\n'))}">${errs.length} greška</span>`);

  const cells = cols.map(c => {
    const v = r[c.key] ?? '';
    if (c.type === 'bool') {
      return `<td><input type="checkbox" data-row="${i}" data-col="${c.key}" ${v ? 'checked' : ''}></td>`;
    }
    if (c.type === 'gender') {
      return `<td><select data-row="${i}" data-col="${c.key}">
          <option value=""></option>
          <option value="M"${v === 'M' ? ' selected' : ''}>M</option>
          <option value="Z"${v === 'Z' ? ' selected' : ''}>Z</option>
        </select></td>`;
    }
    const type = c.type === 'jmbg' ? 'text' : (c.type === 'date' ? 'date' : c.type);
    return `<td><input type="${type}" data-row="${i}" data-col="${c.key}" value="${escHtml(String(v))}" ${c.type === 'jmbg' ? 'maxlength="13" pattern="\\d{13}"' : ''}></td>`;
  }).join('');

  return `<tr data-row-idx="${i}">
    <td class="bulk-idx">${i + 1}</td>
    ${cells}
    <td class="bulk-err">${statusCell}</td>
    <td><button class="btn-row-act danger" data-action="del-row" data-row="${i}" title="Obriši red">×</button></td>
  </tr>`;
}

function refreshGridRow(i) {
  const tbody = modalEl.querySelector('#empBulkGridBody');
  if (!tbody) return;
  const oldTr = tbody.querySelector(`tr[data-row-idx="${i}"]`);
  if (!oldTr) return;
  const tmp = document.createElement('tbody');
  tmp.innerHTML = rowTr(gridRows[i], i);
  const newTr = tmp.firstElementChild;
  oldTr.replaceWith(newTr);
  wireGridRow(newTr);
  updateFooterCounts();
}

function refreshGridAll() {
  const host = modalEl.querySelector('#empBulkBody');
  host.innerHTML = renderGridMode();
  wireGridHost();
  updateFooterCounts();
}

function wireGridRow(tr) {
  tr.querySelectorAll('input, select').forEach(inp => {
    const i = +inp.dataset.row;
    const col = inp.dataset.col;
    const handler = () => {
      const val = inp.type === 'checkbox' ? inp.checked : inp.value;
      gridRows[i][col] = val;
      /* JMBG auto-fill */
      if (col === 'personalId') {
        const parsed = parseJmbgToDobGender(String(val));
        if (parsed) {
          if (!gridRows[i].birthDate) gridRows[i].birthDate = parsed.birthDate;
          if (!gridRows[i].gender) gridRows[i].gender = parsed.gender;
        }
      }
      refreshGridRow(i);
      /* Ako je zadnji red i korisnik je uneo bilo šta → dodaj novi prazan red. */
      if (i === gridRows.length - 1) {
        const hasData = activeColumns().some(c => {
          const v = gridRows[i][c.key];
          return v && !(c.type === 'bool' && v === c.default);
        });
        if (hasData) {
          gridRows.push(makeEmptyRow());
          appendGridRow(gridRows.length - 1);
        }
      }
    };
    inp.addEventListener('change', handler);
    if (inp.tagName === 'INPUT' && inp.type !== 'checkbox') {
      inp.addEventListener('input', () => {
        gridRows[i][col] = inp.value;
      });
      inp.addEventListener('blur', handler);
      /* Enter → naredni red (ista kolona) */
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handler();
          const next = modalEl.querySelector(`[data-row="${i + 1}"][data-col="${col}"]`);
          if (next) next.focus();
        }
      });
    }
  });
  tr.querySelector('[data-action="del-row"]')?.addEventListener('click', () => {
    const i = +tr.dataset.rowIdx;
    gridRows.splice(i, 1);
    if (gridRows.length === 0) gridRows.push(makeEmptyRow());
    refreshGridAll();
  });
}

function appendGridRow(i) {
  const tbody = modalEl.querySelector('#empBulkGridBody');
  if (!tbody) return;
  const tmp = document.createElement('tbody');
  tmp.innerHTML = rowTr(gridRows[i], i);
  const newTr = tmp.firstElementChild;
  tbody.appendChild(newTr);
  wireGridRow(newTr);
  updateFooterCounts();
}

function wireGridHost() {
  modalEl.querySelector('#empBulkAddRowBtn')?.addEventListener('click', () => {
    gridRows.push(makeEmptyRow());
    appendGridRow(gridRows.length - 1);
  });
  modalEl.querySelector('#empBulkClearBtn')?.addEventListener('click', () => {
    if (!confirm('Obrisati sve redove?')) return;
    gridRows = [makeEmptyRow()];
    refreshGridAll();
  });
  modalEl.querySelectorAll('#empBulkGridBody tr').forEach(wireGridRow);
}

/* ─── IMPORT MODE ────────────────────────────────────────────────────── */

function renderImportMode() {
  if (importRows.length === 0) {
    return `
      <div class="emp-bulk-import-drop" id="empBulkDropZone">
        <div class="emp-bulk-import-icon">📂</div>
        <div><strong>Prevuci Excel/CSV ovde</strong> ili klikni da izabereš fajl</div>
        <div class="muted">Podržani formati: .xlsx, .xls, .csv</div>
        <input type="file" id="empBulkFileInput" accept=".xlsx,.xls,.csv" hidden>
      </div>
      <div class="emp-bulk-info">
        <small>Očekivana header polja (prevedeno na srpski u Template-u): Ime, Prezime, Pozicija, Odeljenje, Tim, „Zaposlen od" (datum), Email, Telefon, Aktivan, JMBG, Pol, „Datum rođenja", Adresa, Mesto, „Poštanski br.", Banka, „Broj računa".</small>
      </div>
    `;
  }
  const cols = activeColumns();
  const head = `<tr>
    <th class="bulk-idx">#</th>
    ${cols.map(c => `<th>${escHtml(c.label)}</th>`).join('')}
    <th>Status</th>
  </tr>`;
  const body = importRows.map((r, i) => {
    const errs = validateRow(r);
    const cells = cols.map(c => `<td>${escHtml(String(r[c.key] ?? ''))}</td>`).join('');
    const status = errs.length === 0
      ? '<span class="emp-bulk-status ok">OK</span>'
      : `<span class="emp-bulk-status err" title="${escHtml(errs.join('\n'))}">${errs.length}</span>`;
    return `<tr${errs.length ? ' class="err"' : ''}><td class="bulk-idx">${i + 1}</td>${cells}<td>${status}</td></tr>`;
  }).join('');
  const okCount = importRows.filter(r => validateRow(r).length === 0).length;
  return `
    <div class="emp-bulk-info">
      <strong>${importRows.length} redova</strong> učitano (${okCount} validno, ${importRows.length - okCount} sa greškama).
      <button class="btn btn-ghost btn-sm" id="empBulkReImport" type="button">↺ Drugi fajl</button>
    </div>
    <div class="emp-bulk-grid-wrap">
      <table class="emp-bulk-grid preview">
        <thead>${head}</thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

function wireImportMode() {
  const drop = modalEl.querySelector('#empBulkDropZone');
  if (drop) {
    const input = modalEl.querySelector('#empBulkFileInput');
    drop.addEventListener('click', () => input.click());
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => {
      e.preventDefault();
      drop.classList.remove('over');
      const f = e.dataTransfer?.files?.[0];
      if (f) handleImportFile(f);
    });
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      if (f) handleImportFile(f);
    });
  }
  modalEl.querySelector('#empBulkReImport')?.addEventListener('click', () => {
    importRows = [];
    refreshBody();
  });
}

async function handleImportFile(file) {
  try {
    const XLSX = await loadXlsx();
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array', cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) { showToast('Fajl je prazan'); return; }
    const raw = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false, dateNF: 'yyyy-mm-dd' });
    importRows = mapExcelRows(raw);
    refreshBody();
    showToast(`✔ Učitano ${importRows.length} redova`);
  } catch (e) {
    console.error('[bulk-import] parse fail', e);
    showToast('⚠ Ne mogu da pročitam fajl');
  }
}

function mapExcelRows(raw) {
  const cols = activeColumns();
  const headerMap = new Map();
  /* Izvuci header iz prvog reda ako postoji. `sheet_to_json` već vraća objekat
     gde su ključevi originalni header string-ovi — gradimo map key→col. */
  if (raw.length > 0) {
    const firstKeys = Object.keys(raw[0]);
    for (const hk of firstKeys) {
      const norm = normHeader(hk);
      const col = cols.find(c =>
        normHeader(c.label) === norm ||
        (c.aliases || []).some(a => normHeader(a) === norm)
      );
      if (col) headerMap.set(hk, col);
    }
  }
  return raw
    .map(src => {
      const r = makeEmptyRow();
      for (const [hk, col] of headerMap.entries()) {
        let v = src[hk];
        if (v === undefined || v === null) continue;
        if (col.type === 'date') v = normalizeDate(v);
        else if (col.type === 'bool') v = normalizeBool(v);
        else if (col.type === 'jmbg') v = String(v).replace(/\D/g, '');
        else if (col.type === 'gender') v = String(v).trim().toUpperCase();
        else v = String(v).trim();
        r[col.key] = v;
      }
      /* JMBG auto-fill ako nedostaje DOB/gender */
      if (r.personalId) {
        const parsed = parseJmbgToDobGender(r.personalId);
        if (parsed) {
          if (!r.birthDate) r.birthDate = parsed.birthDate;
          if (!r.gender) r.gender = parsed.gender;
        }
      }
      return r;
    })
    /* Skini sasvim prazne redove */
    .filter(r => activeColumns().some(c =>
      c.required ? !!r[c.key] : false
    ) || Object.values(r).some(v => v && v !== false));
}

/* ─── FOOTER / SAVE ──────────────────────────────────────────────────── */

function updateFooterCounts() {
  const footer = modalEl.querySelector('#empBulkFooter');
  if (!footer) return;

  let total = 0, ok = 0, err = 0;
  const rows = activeMode === 'grid' ? gridRows : importRows;
  rows.forEach(r => {
    const empty = activeColumns().every(c => {
      const v = r[c.key];
      return !v || (c.type === 'bool' && v === c.default);
    });
    if (empty) return;
    total++;
    validateRow(r).length === 0 ? ok++ : err++;
  });

  footer.innerHTML = `
    <div class="emp-bulk-summary">
      <span><strong>${total}</strong> redova</span>
      <span class="ok">✔ ${ok} validno</span>
      ${err > 0 ? `<span class="err">✖ ${err} sa greškama</span>` : ''}
    </div>
    <div class="pm-modal-actions">
      <button class="btn btn-ghost" id="empBulkCancel" type="button">Otkaži</button>
      <button class="btn btn-primary" id="empBulkSaveBtn" type="button" ${ok === 0 ? 'disabled' : ''}>
        💾 Sačuvaj ${ok} ${ok === 1 ? 'zaposlenog' : 'zaposlenih'}
      </button>
    </div>
  `;
  footer.querySelector('#empBulkCancel')?.addEventListener('click', closeModal);
  footer.querySelector('#empBulkSaveBtn')?.addEventListener('click', saveAllRows);
}

async function saveAllRows() {
  const rows = activeMode === 'grid' ? gridRows : importRows;
  const valid = rows.filter(r => {
    const empty = activeColumns().every(c => !r[c.key] || (c.type === 'bool' && r[c.key] === c.default));
    return !empty && validateRow(r).length === 0;
  });
  if (valid.length === 0) return;

  const btn = modalEl.querySelector('#empBulkSaveBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Čuvam…'; }

  let ok = 0, fail = 0;
  for (const r of valid) {
    const res = await saveEmployeeToDb(r);
    if (res) ok++;
    else fail++;
  }

  if (ok > 0) showToast(`✔ Sačuvano ${ok} zaposlenih`);
  if (fail > 0) showToast(`⚠ ${fail} neuspešnih — proveri konzolu`);

  onSavedCb?.();
  closeModal();
}

/* ─── TAB SWITCH + BODY RENDER ───────────────────────────────────────── */

function refreshBody() {
  const body = modalEl.querySelector('#empBulkBody');
  if (!body) return;
  body.innerHTML = activeMode === 'grid' ? renderGridMode() : renderImportMode();
  if (activeMode === 'grid') wireGridHost(); else wireImportMode();
  updateFooterCounts();
}

/* ─── OPEN / CLOSE ───────────────────────────────────────────────────── */

export function openEmployeesBulkModal({ onSaved } = {}) {
  if (modalEl) return;
  onSavedCb = onSaved || null;
  activeMode = 'grid';
  gridRows = [makeEmptyRow()];
  importRows = [];

  const host = document.createElement('div');
  host.id = 'empBulkHost';
  host.innerHTML = modalHtml();
  document.body.appendChild(host);
  modalEl = host;

  modalEl.querySelector('#empBulkBackdrop').addEventListener('click', closeModal);
  modalEl.querySelector('#empBulkClose').addEventListener('click', closeModal);
  modalEl.querySelectorAll('[data-bulk-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      activeMode = btn.dataset.bulkMode;
      modalEl.querySelectorAll('[data-bulk-mode]').forEach(b => {
        const active = b.dataset.bulkMode === activeMode;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', String(active));
      });
      refreshBody();
    });
  });
  modalEl.querySelector('#empBulkTemplateBtn').addEventListener('click', () => {
    downloadEmployeesTemplate().catch(e => {
      console.error(e);
      showToast('⚠ Template generisanje nije uspelo');
    });
  });

  refreshBody();

  /* ESC za zatvaranje */
  document.addEventListener('keydown', escHandler);
}

function escHandler(e) {
  if (e.key === 'Escape' && modalEl) closeModal();
}

function closeModal() {
  if (!modalEl) return;
  modalEl.remove();
  modalEl = null;
  onSavedCb = null;
  document.removeEventListener('keydown', escHandler);
}

/* ─── EXCEL TEMPLATE ─────────────────────────────────────────────────── */

export async function downloadEmployeesTemplate() {
  const XLSX = await loadXlsx();
  const cols = activeColumns();
  const header = cols.map(c => c.label);
  const example = cols.map(c => {
    switch (c.key) {
      case 'firstName':   return 'Petar';
      case 'lastName':    return 'Petrović';
      case 'position':    return 'Monter';
      case 'department':  return 'Montaža';
      case 'team':        return 'Tim A';
      case 'hireDate':    return '2025-01-15';
      case 'email':       return 'petar@servoteh.com';
      case 'phoneWork':   return '+381641234567';
      case 'isActive':    return 'DA';
      case 'personalId':  return '0101990710123';
      case 'gender':      return 'M';
      case 'birthDate':   return '1990-01-01';
      case 'address':     return 'Knez Mihailova 1';
      case 'city':        return 'Beograd';
      case 'postalCode':  return '11000';
      case 'bankName':    return 'Intesa';
      case 'bankAccount': return '160-0000000000000-00';
      default:            return '';
    }
  });
  const aoa = [header, example];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  /* Auto-width */
  ws['!cols'] = cols.map(c => ({ wch: Math.max(c.label.length + 2, 14) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Zaposleni');

  /* Uputstvo sheet */
  const info = [
    ['Uputstvo za popunjavanje — Zaposleni'],
    [''],
    ['Obavezna polja: Ime, Prezime, „Zaposlen od" (datum)'],
    ['Datumi: YYYY-MM-DD (npr. 2025-03-14). Excel date ćelije se automatski konvertuju.'],
    ['Pol: M ili Z. JMBG mora imati 13 cifara. Iz JMBG-a se auto-popunjavaju pol i datum rođenja ako su prazni.'],
    ['„Aktivan": DA/NE (ili 1/0).'],
    [''],
    ['Osetljiva polja (JMBG, adresa, banka) vide i unose samo administratori.'],
  ];
  const wsInfo = XLSX.utils.aoa_to_sheet(info);
  wsInfo['!cols'] = [{ wch: 100 }];
  XLSX.utils.book_append_sheet(wb, wsInfo, 'Uputstvo');

  const today = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `zaposleni-template-${today}.xlsx`);
}
