/**
 * UI tab „Katalog mašina” u Održavanju.
 * URL: /maintenance/catalog
 *
 * Chief/admin (ili ERP admin) upravljaju `maint_machines`:
 *   - izmena naziva i metapodataka (type, model, godina, lokacija, beleške…)
 *   - arhiviranje (soft-delete) i vraćanje iz arhive
 *   - ručno dodavanje (mašine van BigTehn-a, npr. kompresor, HVAC)
 *   - masovni uvoz iz BigTehn cache-a (v_maint_machines_importable)
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { getAuth, isAdminOrMenadzment } from '../../state/auth.js';
import {
  fetchMaintMachines,
  insertMaintMachine,
  patchMaintMachine,
  archiveMaintMachine,
  restoreMaintMachine,
  fetchMaintMachinesImportable,
  importMaintMachinesFromCache,
  renameMaintMachine,
  deleteMaintMachineHard,
  fetchMaintMachineDeletionLog,
  fetchMaintMachineFilesCounts,
} from '../../services/maintenance.js';
import { buildMaintenanceMachinePath } from '../../lib/appPaths.js';
import { renderMaintFilesTab } from './maintFilesTab.js';

/* Kolone za inline spreadsheet. Red je i TAB-redosled. */
const MACHINE_TYPE_SUGGESTIONS = [
  'CNC tokarilica',
  'CNC obradni centar',
  'Horizontalni obradni centar',
  'Vertikalni obradni centar',
  'Univerzalna tokarilica',
  'Universalna glodalica',
  'Brusilica',
  'Presa',
  'Mašina za sečenje lima',
  'Mašina za savijanje',
  'Aparat za zavarivanje',
  'Kompresor',
  'HVAC',
  'Dizalica',
  'Transportna traka',
];

/**
 * @param {object|null} prof
 */
export function canManageMaintCatalog(prof) {
  if (getAuth().role === 'admin') return true;
  const r = prof?.role;
  return r === 'chief' || r === 'admin';
}

/**
 * Trajno brisanje mašine (hard delete) i pristup audit log-u brisanja.
 * Širi krug ovlašćenja od `canManageMaintCatalog`: pored maint chief/admin
 * dozvoljeno i ERP menadzment-u (`role='menadzment'` u user_roles), tako da
 * rukovodstvo može da uklanja mašine iz katalogа bez maint profila.
 *
 * Sinhronizovano sa Postgres helperom `maint_is_erp_admin_or_management()`
 * i RLS politikom `maint_machines_delete`.
 *
 * @param {object|null} prof
 */
export function canHardDeleteMaintMachine(prof) {
  if (isAdminOrMenadzment()) return true;
  const r = prof?.role;
  return r === 'chief' || r === 'admin';
}

function escAttr(v) {
  return escHtml(v == null ? '' : String(v));
}

function fmtYear(y) {
  if (y == null || y === '') return '';
  return String(y);
}

/**
 * Opis jedne kolone u spreadsheet-u. `key` je property iz `maint_machines`
 * (ili `__actions` / `__tracked` za specijalne kolone).
 * @typedef {{
 *   key: string,
 *   label: string,
 *   type?: 'text'|'number'|'checkbox',
 *   sortable?: boolean,
 *   sortType?: 'string'|'number',
 *   colClass?: string,
 *   inputClass?: string,
 *   placeholder?: string,
 *   datalistId?: string,
 *   maxLen?: number,
 *   min?: number,
 *   max?: number,
 *   step?: number|string,
 * }} EditColDef
 */
const EDIT_COLS = /** @type {EditColDef[]} */ ([
  { key: 'machine_code',        label: 'Šifra',       sortable: true,  sortType: 'string', colClass: 'mnt-col-code'   },
  { key: 'name',                label: 'Naziv',       type: 'text', sortable: true, sortType: 'string', colClass: 'mnt-col-name',  maxLen: 200, placeholder: 'DMG Mori NLX 2500' },
  { key: 'type',                label: 'Tip',         type: 'text', sortable: true, sortType: 'string', colClass: 'mnt-col-type',  maxLen: 120, datalistId: 'mntEditTypeList', placeholder: 'CNC, Presa…' },
  { key: 'manufacturer',        label: 'Proizvođač',  type: 'text', sortable: true, sortType: 'string', colClass: 'mnt-col-mfr',   maxLen: 120, placeholder: 'DMG Mori' },
  { key: 'model',               label: 'Model',       type: 'text', sortable: true, sortType: 'string', colClass: 'mnt-col-model', maxLen: 120, placeholder: 'NLX 2500' },
  { key: 'serial_number',       label: 'Serijski br.', type: 'text', sortable: false, colClass: 'mnt-col-serial', maxLen: 120 },
  { key: 'year_of_manufacture', label: 'God. pr.',    type: 'number', sortable: true, sortType: 'number', colClass: 'mnt-col-year', inputClass: 'mnt-cell-input--num', min: 1900, max: 2099 },
  { key: 'year_commissioned',   label: 'God. pogon',  type: 'number', sortable: true, sortType: 'number', colClass: 'mnt-col-year', inputClass: 'mnt-cell-input--num', min: 1900, max: 2099 },
  { key: 'location',            label: 'Lokacija',    type: 'text', sortable: true, sortType: 'string', colClass: 'mnt-col-loc',   maxLen: 200, placeholder: 'Hala 2' },
  { key: '__docs',              label: 'Dok.',        sortable: false, colClass: 'mnt-col-docs' },
  { key: 'power_kw',            label: 'kW',          type: 'number', sortable: true, sortType: 'number', colClass: 'mnt-col-num', inputClass: 'mnt-cell-input--num', min: 0, step: 0.1 },
  { key: 'weight_kg',           label: 'kg',          type: 'number', sortable: true, sortType: 'number', colClass: 'mnt-col-num', inputClass: 'mnt-cell-input--num', min: 0, step: 1 },
  { key: 'tracked',             label: 'Praćena',     type: 'checkbox', sortable: false, colClass: 'mnt-col-track' },
  { key: 'notes',               label: 'Napomene',    type: 'text', sortable: false, colClass: 'mnt-col-notes', maxLen: 2000 },
  { key: '__actions',           label: '',            sortable: false, colClass: 'mnt-col-act' },
]);

/** Kolone u kojima tipujemo da bi dirty-check radio numerički. */
const NUMERIC_COLS = new Set(['year_of_manufacture', 'year_commissioned', 'power_kw', 'weight_kg']);

/**
 * Čita vrednost iz inputa u onom obliku u kom će ići kao PATCH payload.
 * Vraća null za praznu vrednost tekstualnog polja — FK-ovi u DB-u su nullable.
 * @param {HTMLInputElement} el
 * @param {string} key
 */
function readInputValue(el, key) {
  if (!el) return null;
  if (el.type === 'checkbox') return !!el.checked;
  const v = el.value;
  if (NUMERIC_COLS.has(key)) {
    if (v === '' || v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  const s = String(v || '').trim();
  return s === '' ? null : s;
}

/**
 * Normalizuj vrednost iz servera u isti oblik kao `readInputValue` — tako da
 * dirty-check bude pouzdan (null vs. '' vs. 0 su svi validni, moramo konzistentno).
 * @param {any} v
 * @param {string} key
 */
function normalizeStoredValue(v, key) {
  if (key === 'tracked') return v !== false;
  if (NUMERIC_COLS.has(key)) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * Header + filter + inline-editable tabela. Redovi se menjaju u samoj tabeli
 * (TAB kroz ceo red → sledeći red). Enter = sačuvaj trenutni red, Esc = vrati.
 *
 * @param {HTMLElement} host
 * @param {{ prof: object|null, onNavigateToPath?: (p:string)=>void }} ctx
 * @param {{ filter?: 'active'|'archived'|'all', search?: string,
 *           sortKey?: string, sortDir?: 'asc'|'desc' }} [state]
 */
export async function renderMaintCatalogPanel(host, ctx, state = {}) {
  const filter = state.filter || 'active';
  const search = (state.search || '').trim();
  const sortKey = state.sortKey || 'machine_code';
  const sortDir = state.sortDir === 'desc' ? 'desc' : 'asc';
  const canManage = canManageMaintCatalog(ctx.prof);

  /** Originalni snapshot (po machine_code) za dirty-diff i revert. */
  /** @type {Map<string, Record<string, any>>} */
  const originals = new Map();

  /** Broj aktivnih dokumenata po mašini (osvežava se na svako load()). */
  /** @type {Map<string, number>} */
  let filesCounts = new Map();

  const canHardDelete = canHardDeleteMaintMachine(ctx.prof);

  const typeDatalistHtml = `<datalist id="mntEditTypeList">${
    MACHINE_TYPE_SUGGESTIONS.map(t => `<option value="${escAttr(t)}">`).join('')
  }</datalist>`;

  const historyBtn = canHardDelete
    ? `<button type="button" class="btn" id="mntCatHistBtn" style="background:var(--surface3)" title="Pregled svih trajno obrisanih mašina">📋 Istorija brisanja</button>`
    : '';
  const adminToolbar = canManage || canHardDelete
    ? `<span style="flex-basis:100%;height:0"></span>
       ${canManage ? `<button type="button" class="btn" id="mntCatAdd">+ Dodaj mašinu</button>` : ''}
       ${canManage ? `<button type="button" class="btn" id="mntCatImport" style="background:var(--surface3)">Uvezi iz BigTehn-a…</button>` : ''}
       ${historyBtn}`
    : '';

  host.innerHTML = `
    <div class="mnt-panel" style="max-width:none">
      <div style="display:flex;flex-wrap:wrap;align-items:flex-end;gap:12px;margin-bottom:12px">
        <div>
          <label class="form-label" style="margin-bottom:2px">Filter</label>
          <select class="form-input" id="mntCatFilter" style="min-width:160px">
            <option value="active"${filter === 'active' ? ' selected' : ''}>Samo aktivne</option>
            <option value="archived"${filter === 'archived' ? ' selected' : ''}>Samo arhivirane</option>
            <option value="all"${filter === 'all' ? ' selected' : ''}>Sve</option>
          </select>
        </div>
        <div style="flex:1;min-width:200px">
          <label class="form-label" style="margin-bottom:2px">Pretraga (šifra / naziv / model / proizvođač)</label>
          <input class="form-input" id="mntCatSearch" value="${escAttr(search)}" placeholder="npr. 8.3, CNC, DMG…">
        </div>
        <button type="button" class="btn" id="mntCatApply">Primeni</button>
        ${adminToolbar}
        <span style="flex:1"></span>
        <span class="mnt-muted" id="mntCatCount"></span>
      </div>
      ${canManage
        ? `<p class="mnt-muted" style="margin:0 0 8px;font-size:12px">
            Tabela je <strong>direktno upisljiva</strong>: TAB prolazi kroz ćelije,
            <kbd>Enter</kbd> čuva red, <kbd>Esc</kbd> vraća original. Šifra se ne menja
            direktno (zbog referenci u taskovima/incidentima) — koristi dugme <em>Preimenuj</em>.
          </p>`
        : '<p class="mnt-muted" style="margin:0 0 8px;font-size:12px">Read-only pregled (za izmene treba uloga chief/admin ili ERP admin).</p>'}
      ${typeDatalistHtml}
      <div id="mntCatTableHost"><p class="mnt-muted">Učitavam…</p></div>
      <div class="mnt-edit-bar mnt-edit-bar--empty" id="mntCatEditBar">
        <span>Neizmenjene izmene: <strong id="mntCatDirtyCount">0</strong></span>
        <span style="flex:1"></span>
        <button type="button" class="btn" id="mntCatSaveAll">Sačuvaj sve</button>
        <button type="button" class="btn" id="mntCatRevertAll" style="background:var(--surface3)">Poništi sve</button>
      </div>
      <p class="mnt-muted" style="margin-top:14px;font-size:12px">
        „Arhiviraj" je softversko brisanje: red ostaje u bazi (istorija incidenata/napomena se čuva) i može se vratiti u bilo kom trenutku.
      </p>
    </div>
  `;

  const tableHost = host.querySelector('#mntCatTableHost');
  const countEl = host.querySelector('#mntCatCount');
  const editBar = host.querySelector('#mntCatEditBar');
  const dirtyCountEl = host.querySelector('#mntCatDirtyCount');

  /** Prebroji dirty redove i ažuriraj sticky bar. */
  function refreshDirtyBar() {
    const n = tableHost.querySelectorAll('tr.mnt-row-dirty').length;
    dirtyCountEl.textContent = String(n);
    editBar.classList.toggle('mnt-edit-bar--empty', n === 0);
  }

  /** Upareno sa stanjem jednog reda — sve što nam treba za save/revert. */
  function wireRow(tr, row) {
    const code = row.machine_code;
    const orig = originals.get(code);
    const inputs = /** @type {NodeListOf<HTMLInputElement>} */ (
      tr.querySelectorAll('[data-mnt-field]')
    );
    const saveBtn = tr.querySelector('[data-mnt-row-save]');
    const revertBtn = tr.querySelector('[data-mnt-row-revert]');

    function computeDirty() {
      let dirty = false;
      inputs.forEach(inp => {
        const k = inp.getAttribute('data-mnt-field');
        const cur = readInputValue(inp, k);
        const origVal = orig[k];
        /* eslint-disable-next-line eqeqeq */
        if (cur != origVal) {
          /* number/string upoređivanje sa `!=` je namerno — NULL i '' tretiramo isto. */
          if (!(cur == null && origVal == null)) dirty = true;
        }
      });
      tr.classList.toggle('mnt-row-dirty', dirty);
      if (saveBtn) saveBtn.disabled = !dirty;
      if (revertBtn) revertBtn.disabled = !dirty;
      refreshDirtyBar();
      return dirty;
    }

    inputs.forEach(inp => {
      inp.addEventListener('input', computeDirty);
      inp.addEventListener('change', computeDirty);
      inp.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          if (saveBtn && !saveBtn.disabled) saveRow();
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          revertRow();
        }
      });
    });

    async function saveRow() {
      const patch = {};
      inputs.forEach(inp => {
        const k = inp.getAttribute('data-mnt-field');
        const cur = readInputValue(inp, k);
        const origVal = orig[k];
        /* eslint-disable-next-line eqeqeq */
        if (cur != origVal && !(cur == null && origVal == null)) {
          patch[k] = cur;
        }
      });
      if (!Object.keys(patch).length) return;
      if (patch.name != null && String(patch.name).trim() === '') {
        showToast('⚠ Naziv ne sme biti prazan');
        return;
      }
      if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '…'; }
      const ok = await patchMaintMachine(code, patch);
      if (!ok) {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾'; }
        showToast('⚠ Snimanje nije uspelo (ovlašćenja ili validacija)');
        return;
      }
      /* Uspelo — novi „original" = trenutno stanje u inputima. */
      inputs.forEach(inp => {
        const k = inp.getAttribute('data-mnt-field');
        orig[k] = readInputValue(inp, k);
      });
      if (saveBtn) saveBtn.textContent = '💾';
      tr.classList.remove('mnt-row-dirty');
      if (saveBtn) saveBtn.disabled = true;
      if (revertBtn) revertBtn.disabled = true;
      refreshDirtyBar();
      showToast('✅ Sačuvano');
    }

    function revertRow() {
      inputs.forEach(inp => {
        const k = inp.getAttribute('data-mnt-field');
        const v = orig[k];
        if (inp.type === 'checkbox') inp.checked = !!v;
        else if (v == null) inp.value = '';
        else inp.value = String(v);
      });
      computeDirty();
    }

    saveBtn?.addEventListener('click', saveRow);
    revertBtn?.addEventListener('click', revertRow);

    tr.querySelector('[data-mnt-row-rename]')?.addEventListener('click', async () => {
      const oldCode = code;
      /* eslint-disable-next-line no-alert */
      const proposed = prompt(
        `Preimenuj šifru mašine "${oldCode}" u:\n\n(atomski menja sve maint_* tabele)`,
        oldCode,
      );
      if (proposed == null) return;
      const newCode = String(proposed).trim();
      if (!newCode || newCode === oldCode) return;
      /* eslint-disable-next-line no-alert */
      if (!confirm(`POTVRDI: preimenovati "${oldCode}" → "${newCode}"?\n\nOva promena je transakciona i prepisuje machine_code u svim maint_* tabelama.`)) {
        return;
      }
      const res = await renameMaintMachine(oldCode, newCode);
      if (!res.ok) {
        showToast(`⚠ ${res.error || 'Preimenovanje nije uspelo.'}`);
        return;
      }
      const r = res.result || {};
      showToast(`✅ Preimenovano: tasks ${r.tasks ?? 0}, incidenti ${r.incidents ?? 0}, napomene ${r.notes ?? 0}`);
      load();
    });

    tr.querySelector('[data-mnt-row-archive]')?.addEventListener('click', async () => {
      /* eslint-disable-next-line no-alert */
      if (!confirm(`Arhivirati mašinu ${code}? (neće biti u listama, ali istorija ostaje)`)) return;
      const ok = await archiveMaintMachine(code);
      if (!ok) { showToast('⚠ Arhiviranje nije dozvoljeno'); return; }
      showToast('✅ Arhivirano');
      load();
    });

    tr.querySelector('[data-mnt-row-restore]')?.addEventListener('click', async () => {
      const ok = await restoreMaintMachine(code);
      if (!ok) { showToast('⚠ Vraćanje nije dozvoljeno'); return; }
      showToast('✅ Vraćeno');
      load();
    });

    tr.querySelector('[data-mnt-row-delete]')?.addEventListener('click', () => {
      openMaintMachineDeleteDialog({
        machine: row,
        filesCount: filesCounts.get(code) || 0,
        onDeleted: () => {
          showToast('🗑 Mašina trajno obrisana (audit zapis sačuvan)');
          load();
        },
      });
    });

    tr.querySelector('[data-mnt-row-docs]')?.addEventListener('click', () => {
      openMaintMachineDocsDialog({
        machineCode: code,
        machineName: row.name,
        prof: ctx.prof,
        archived: !!row.archived_at,
        onChanged: () => {
          /* Re-fetchuj samo brojače pa osveži badge u redu — ne čitamo ceo katalog. */
          fetchMaintMachineFilesCounts().then(c => {
            filesCounts = c instanceof Map ? c : new Map();
            const btn = tr.querySelector('[data-mnt-row-docs]');
            if (btn) {
              const n = filesCounts.get(code) || 0;
              btn.textContent = n ? `📎 ${n}` : '📎 +';
              btn.className = n ? 'mnt-docs-badge mnt-docs-badge--has' : 'mnt-docs-badge';
            }
          }).catch(() => { /* ignore */ });
        },
      });
    });

    tr.querySelector('[data-mnt-nav]')?.addEventListener('click', e => {
      e.stopPropagation();
      const p = /** @type {HTMLElement} */ (e.currentTarget).getAttribute('data-mnt-nav');
      if (p && ctx.onNavigateToPath) ctx.onNavigateToPath(p);
    });
  }

  function renderCell(col, row) {
    const k = col.key;
    if (k === 'machine_code') {
      const path = buildMaintenanceMachinePath(row.machine_code, 'pregled');
      const srcBadge = row.source === 'manual'
        ? ` <span class="mnt-badge" title="Ručno dodata (van BigTehn-a)" style="font-size:10px;padding:1px 5px">MAN</span>`
        : '';
      const archBadge = row.archived_at
        ? ` <span class="mnt-badge mnt-badge--down" style="font-size:10px;padding:1px 5px">ARH</span>`
        : '';
      return `<button type="button" class="mnt-linkish" data-mnt-nav="${escAttr(path)}" tabindex="-1"><code>${escHtml(row.machine_code || '')}</code></button>${srcBadge}${archBadge}`;
    }
    if (k === '__docs') {
      const n = filesCounts.get(row.machine_code) || 0;
      const titleTxt = n
        ? `${n} dokument${n === 1 ? '' : 'a'} (klik = upravljanje)`
        : 'Dodaj dokument (uputstva, slike, crteže…)';
      const cls = n ? 'mnt-docs-badge mnt-docs-badge--has' : 'mnt-docs-badge';
      const label = n ? `📎 ${n}` : '📎 +';
      return `<button type="button" class="${cls}" tabindex="-1" data-mnt-row-docs title="${escAttr(titleTxt)}">${label}</button>`;
    }
    if (k === '__actions') {
      const archived = !!row.archived_at;
      const renameBtn = canManage
        ? `<button type="button" class="btn" tabindex="-1" data-mnt-row-rename title="Preimenuj šifru">Preimenuj</button>`
        : '';
      const archBtn = canManage
        ? (archived
          ? `<button type="button" class="btn" tabindex="-1" data-mnt-row-restore title="Vrati iz arhive" style="background:var(--surface3)">Vrati</button>`
          : `<button type="button" class="btn" tabindex="-1" data-mnt-row-archive title="Arhiviraj (čuva istoriju)" style="background:var(--red-bg);color:var(--red)">Arhiv.</button>`)
        : '';
      const delBtn = canHardDelete
        ? `<button type="button" class="btn" tabindex="-1" data-mnt-row-delete title="TRAJNO obriši mašinu (audit zapis ostaje)" style="background:#3a1414;color:#ff8b8b;border:1px solid #5a1d1d">🗑 Obriši</button>`
        : '';
      const saveBtn = canManage
        ? `<button type="button" class="btn" tabindex="-1" data-mnt-row-save title="Sačuvaj red (Enter)" disabled>💾</button>`
        : '';
      const revertBtn = canManage
        ? `<button type="button" class="btn" tabindex="-1" data-mnt-row-revert title="Vrati izmene (Esc)" style="background:var(--surface3)" disabled>↺</button>`
        : '';
      return `<div class="mnt-row-act">${saveBtn}${revertBtn}${renameBtn}${archBtn}${delBtn}</div>`;
    }
    const val = row[k];
    const readonly = !canManage;
    if (col.type === 'checkbox') {
      return `<input type="checkbox" data-mnt-field="${escAttr(k)}" ${val !== false ? 'checked' : ''}${readonly ? ' disabled' : ''}>`;
    }
    const cls = `mnt-cell-input${col.inputClass ? ' ' + col.inputClass : ''}`;
    const typeAttr = col.type === 'number' ? 'type="number"' : 'type="text"';
    const vAttr = val == null ? '' : escAttr(String(val));
    const extra = [];
    if (col.maxLen) extra.push(`maxlength="${col.maxLen}"`);
    if (col.min != null) extra.push(`min="${col.min}"`);
    if (col.max != null) extra.push(`max="${col.max}"`);
    if (col.step != null) extra.push(`step="${col.step}"`);
    if (col.datalistId) extra.push(`list="${escAttr(col.datalistId)}"`);
    if (col.placeholder) extra.push(`placeholder="${escAttr(col.placeholder)}"`);
    if (readonly) extra.push('readonly');
    return `<input ${typeAttr} class="${cls}" data-mnt-field="${escAttr(k)}" value="${vAttr}" ${extra.join(' ')}>`;
  }

  async function load() {
    tableHost.innerHTML = `<p class="mnt-muted">Učitavam…</p>`;
    const includeArchived = filter !== 'active';
    const [rows, counts] = await Promise.all([
      fetchMaintMachines({ includeArchived }),
      fetchMaintMachineFilesCounts().catch(() => new Map()),
    ]);
    filesCounts = counts instanceof Map ? counts : new Map();
    if (rows === null) {
      tableHost.innerHTML = `<p class="mnt-muted">Ne mogu da učitam katalog (RLS ili migracija nije primenjena).</p>`;
      countEl.textContent = '';
      return;
    }
    let list = Array.isArray(rows) ? rows : [];
    if (filter === 'archived') list = list.filter(r => r.archived_at);
    if (filter === 'active') list = list.filter(r => !r.archived_at);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(r => {
        const hay = [
          r.machine_code, r.name, r.type, r.manufacturer,
          r.model, r.serial_number, r.location,
        ].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
      });
    }

    /* Sortiraj po izabranoj koloni. */
    const sortCol = EDIT_COLS.find(c => c.key === sortKey) || EDIT_COLS[0];
    const isNum = sortCol.sortType === 'number';
    const dir = sortDir === 'desc' ? -1 : 1;
    list = list.slice().sort((a, b) => {
      const va = a[sortKey];
      const vb = b[sortKey];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (isNum) return (Number(va) - Number(vb)) * dir;
      return String(va).localeCompare(String(vb), 'sr', { numeric: true, sensitivity: 'base' }) * dir;
    });

    countEl.textContent = `${list.length} redova`;
    originals.clear();
    list.forEach(r => {
      const snap = {};
      EDIT_COLS.forEach(c => {
        if (c.key.startsWith('__') || c.key === 'machine_code') return;
        snap[c.key] = normalizeStoredValue(r[c.key], c.key);
      });
      originals.set(r.machine_code, snap);
    });

    if (!list.length) {
      tableHost.innerHTML = `<p class="mnt-muted">Nema redova za dati filter.</p>`;
      refreshDirtyBar();
      return;
    }

    const theadCells = EDIT_COLS.map(c => {
      const arrow = c.key === sortKey ? (sortDir === 'asc' ? '▲' : '▼') : '';
      const sortCls = c.sortable ? ' mnt-th-sort' : '';
      const attr = c.sortable ? ` data-mnt-sort="${escAttr(c.key)}"` : '';
      return `<th class="${c.colClass || ''}${sortCls}"${attr}>${escHtml(c.label)}${arrow ? ` <span class="mnt-sort-arrow">${arrow}</span>` : ''}</th>`;
    }).join('');

    const tbodyHtml = list.map(r => {
      const cls = r.archived_at ? ' class="mnt-row-archived"' : '';
      const cells = EDIT_COLS.map(c => `<td class="${c.colClass || ''}">${renderCell(c, r)}</td>`).join('');
      return `<tr${cls} data-mnt-code="${escAttr(r.machine_code)}">${cells}</tr>`;
    }).join('');

    tableHost.innerHTML = `
      <div class="mnt-table-wrap">
        <table class="mnt-table mnt-table--edit" aria-label="Katalog mašina — direktno uređivanje">
          <thead><tr>${theadCells}</tr></thead>
          <tbody>${tbodyHtml}</tbody>
        </table>
      </div>
    `;

    const rowByCode = new Map(list.map(r => [r.machine_code, r]));
    tableHost.querySelectorAll('tr[data-mnt-code]').forEach(tr => {
      const code = tr.getAttribute('data-mnt-code');
      const row = rowByCode.get(code);
      if (row) wireRow(tr, row);
    });

    /* Sort iz header-a */
    tableHost.querySelectorAll('th[data-mnt-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const k = th.getAttribute('data-mnt-sort');
        if (!k) return;
        /* Upozori ako ima unsaved izmena — prekid redoreda bi obrisao inpute. */
        if (tableHost.querySelector('tr.mnt-row-dirty')) {
          /* eslint-disable-next-line no-alert */
          if (!confirm('Imaš neizmenjene izmene — ako promeniš sortiranje, one će biti odbačene. Nastaviti?')) return;
        }
        const nextDir = (k === sortKey && sortDir === 'asc') ? 'desc' : 'asc';
        renderMaintCatalogPanel(host, ctx, {
          filter, search, sortKey: k, sortDir: nextDir,
        });
      });
    });

    refreshDirtyBar();
  }

  host.querySelector('#mntCatApply')?.addEventListener('click', () => {
    const f = host.querySelector('#mntCatFilter').value;
    const s = host.querySelector('#mntCatSearch').value.trim();
    if (tableHost.querySelector('tr.mnt-row-dirty')) {
      /* eslint-disable-next-line no-alert */
      if (!confirm('Imaš neizmenjene izmene — primena filtera će ih odbaciti. Nastaviti?')) return;
    }
    renderMaintCatalogPanel(host, ctx, { filter: f, search: s, sortKey, sortDir });
  });
  host.querySelector('#mntCatSearch')?.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      host.querySelector('#mntCatApply').click();
    }
  });
  host.querySelector('#mntCatHistBtn')?.addEventListener('click', () => {
    openMaintDeletionLogDialog();
  });

  if (canManage) {
    host.querySelector('#mntCatAdd')?.addEventListener('click', () => {
      openMaintMachineModal({
        mode: 'create',
        existing: null,
        onSaved: () => renderMaintCatalogPanel(host, ctx, { filter, search, sortKey, sortDir }),
      });
    });
    host.querySelector('#mntCatImport')?.addEventListener('click', () => {
      openMaintMachinesImportDialog({
        onImported: () => renderMaintCatalogPanel(host, ctx, { filter, search, sortKey, sortDir }),
      });
    });
    host.querySelector('#mntCatSaveAll')?.addEventListener('click', async () => {
      const dirtyRows = Array.from(tableHost.querySelectorAll('tr.mnt-row-dirty'));
      if (!dirtyRows.length) return;
      const btn = host.querySelector('#mntCatSaveAll');
      btn.disabled = true;
      const orig0 = btn.textContent;
      btn.textContent = `Snimam… 0/${dirtyRows.length}`;
      let ok = 0;
      let fail = 0;
      for (let i = 0; i < dirtyRows.length; i++) {
        const tr = dirtyRows[i];
        const code = tr.getAttribute('data-mnt-code');
        const orig = originals.get(code) || {};
        const patch = {};
        tr.querySelectorAll('[data-mnt-field]').forEach(inp => {
          const k = inp.getAttribute('data-mnt-field');
          const cur = readInputValue(inp, k);
          /* eslint-disable-next-line eqeqeq */
          if (cur != orig[k] && !(cur == null && orig[k] == null)) {
            patch[k] = cur;
          }
        });
        if (!Object.keys(patch).length) continue;
        if (patch.name != null && String(patch.name).trim() === '') {
          fail++;
          continue;
        }
        /* eslint-disable-next-line no-await-in-loop */
        const res = await patchMaintMachine(code, patch);
        if (res) {
          ok++;
          tr.querySelectorAll('[data-mnt-field]').forEach(inp => {
            const k = inp.getAttribute('data-mnt-field');
            orig[k] = readInputValue(inp, k);
          });
          tr.classList.remove('mnt-row-dirty');
          tr.querySelector('[data-mnt-row-save]').disabled = true;
          tr.querySelector('[data-mnt-row-revert]').disabled = true;
        } else {
          fail++;
        }
        btn.textContent = `Snimam… ${i + 1}/${dirtyRows.length}`;
      }
      btn.disabled = false;
      btn.textContent = orig0;
      refreshDirtyBar();
      showToast(fail ? `⚠ Sačuvano ${ok}, neuspelo ${fail}` : `✅ Sačuvano ${ok}`);
    });
    host.querySelector('#mntCatRevertAll')?.addEventListener('click', () => {
      const dirtyRows = tableHost.querySelectorAll('tr.mnt-row-dirty');
      dirtyRows.forEach(tr => {
        const code = tr.getAttribute('data-mnt-code');
        const orig = originals.get(code) || {};
        tr.querySelectorAll('[data-mnt-field]').forEach(inp => {
          const k = inp.getAttribute('data-mnt-field');
          const v = orig[k];
          if (inp.type === 'checkbox') inp.checked = !!v;
          else if (v == null) inp.value = '';
          else inp.value = String(v);
        });
        tr.classList.remove('mnt-row-dirty');
        tr.querySelector('[data-mnt-row-save]').disabled = true;
        tr.querySelector('[data-mnt-row-revert]').disabled = true;
      });
      refreshDirtyBar();
    });
  }

  await load();
}

/* ── Modal: create / edit mašine ───────────────────────────────────────── */

/**
 * @param {{ mode: 'create'|'edit', existing: object|null, onSaved?: ()=>void }} opts
 */
export function openMaintMachineModal(opts) {
  const isEdit = opts.mode === 'edit';
  const ex = opts.existing || {};
  const wrap = document.createElement('div');
  wrap.className = 'kadr-modal-overlay';
  wrap.innerHTML = `
    <div class="kadr-modal" style="max-width:680px">
      <div class="kadr-modal-title">${isEdit ? 'Uredi mašinu' : 'Dodaj mašinu'}</div>
      <div class="kadr-modal-subtitle">${isEdit ? `<code>${escHtml(ex.machine_code || '')}</code>` : 'Šifra se kasnije NE može menjati — uneta je u sve incidente/taskove.'}</div>
      <div class="kadr-modal-err" id="mntMachDlgErr"></div>
      <form id="mntMachDlgForm">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div style="grid-column:1 / -1">
            <label class="form-label">Šifra mašine *</label>
            <div style="display:flex;gap:6px;align-items:center">
              <input class="form-input" id="mntMachCode" required maxlength="60"
                value="${escAttr(ex.machine_code || '')}"
                ${isEdit ? 'readonly style="background:var(--surface3);flex:1"' : 'style="flex:1"'}
                placeholder="npr. 8.3, KOMP-01">
              ${isEdit ? `<button type="button" class="btn" id="mntMachRenameBtn" style="background:var(--surface3)" title="Preimenuj šifru u svim tabelama (Chief/Admin)">Promeni šifru…</button>` : ''}
            </div>
            ${isEdit ? '<p class="form-hint" style="margin-top:4px;font-size:11px">Preimenovanje atomski menja šifru u maint_tasks/checks/incidents/notes/override/notifications.</p>' : ''}
          </div>
          <div style="grid-column:1 / -1">
            <label class="form-label">Naziv *</label>
            <input class="form-input" id="mntMachName" required maxlength="200" value="${escAttr(ex.name || '')}" placeholder="npr. DMG Mori NLX 2500">
          </div>
          <div>
            <label class="form-label">Tip</label>
            <input class="form-input" id="mntMachType" maxlength="120" value="${escAttr(ex.type || '')}" placeholder="CNC tokarilica, Presa, Kompresor…" list="mntMachTypeList">
            <datalist id="mntMachTypeList">
              <option value="CNC tokarilica">
              <option value="CNC obradni centar">
              <option value="Horizontalni obradni centar">
              <option value="Vertikalni obradni centar">
              <option value="Univerzalna tokarilica">
              <option value="Universalna glodalica">
              <option value="Brusilica">
              <option value="Presa">
              <option value="Mašina za sečenje lima">
              <option value="Mašina za savijanje">
              <option value="Aparat za zavarivanje">
              <option value="Kompresor">
              <option value="HVAC">
              <option value="Dizalica">
              <option value="Transportna traka">
            </datalist>
          </div>
          <div>
            <label class="form-label">Proizvođač</label>
            <input class="form-input" id="mntMachMfr" maxlength="120" value="${escAttr(ex.manufacturer || '')}" placeholder="DMG Mori, Mazak, Trumpf…">
          </div>
          <div>
            <label class="form-label">Model</label>
            <input class="form-input" id="mntMachModel" maxlength="120" value="${escAttr(ex.model || '')}" placeholder="npr. NLX 2500">
          </div>
          <div>
            <label class="form-label">Serijski broj</label>
            <input class="form-input" id="mntMachSerial" maxlength="120" value="${escAttr(ex.serial_number || '')}">
          </div>
          <div>
            <label class="form-label">Godina proizvodnje</label>
            <input class="form-input" id="mntMachYearMfr" type="number" min="1900" max="2099" value="${escAttr(fmtYear(ex.year_of_manufacture))}">
          </div>
          <div>
            <label class="form-label">Godina puštanja u pogon</label>
            <input class="form-input" id="mntMachYearCom" type="number" min="1900" max="2099" value="${escAttr(fmtYear(ex.year_commissioned))}">
          </div>
          <div style="grid-column:1 / -1">
            <label class="form-label">Lokacija</label>
            <input class="form-input" id="mntMachLoc" maxlength="200" value="${escAttr(ex.location || '')}" placeholder="npr. Hala 2, linija B, pozicija 4">
          </div>
          <div>
            <label class="form-label">Snaga (kW)</label>
            <input class="form-input" id="mntMachPower" type="number" min="0" step="0.1" value="${escAttr(ex.power_kw != null ? ex.power_kw : '')}">
          </div>
          <div>
            <label class="form-label">Težina (kg)</label>
            <input class="form-input" id="mntMachWeight" type="number" min="0" step="1" value="${escAttr(ex.weight_kg != null ? ex.weight_kg : '')}">
          </div>
          <div style="grid-column:1 / -1">
            <label class="form-label">Napomene</label>
            <textarea class="form-input" id="mntMachNotes" rows="3" maxlength="2000" placeholder="Specifičnosti, istorija remonta, linkovi na dokumentaciju…">${escHtml(ex.notes || '')}</textarea>
          </div>
          <div style="grid-column:1 / -1;display:flex;align-items:center;gap:8px">
            <input type="checkbox" id="mntMachTracked" ${ex.tracked !== false ? 'checked' : ''}>
            <label for="mntMachTracked" class="form-label" style="margin:0">Praćena u modulu Održavanje (prikazuje se u listama)</label>
          </div>
        </div>
        <div class="kadr-modal-actions" style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
          <span style="flex:1"></span>
          <button type="button" class="btn" id="mntMachDlgCancel" style="background:var(--surface3)">Otkaži</button>
          <button type="submit" class="btn" id="mntMachDlgSave">${isEdit ? 'Sačuvaj' : 'Dodaj'}</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(wrap);

  const close = () => wrap.remove();
  wrap.querySelector('#mntMachDlgCancel')?.addEventListener('click', close);
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });

  const errEl = wrap.querySelector('#mntMachDlgErr');
  const setErr = msg => {
    errEl.textContent = msg || '';
    errEl.style.display = msg ? 'block' : 'none';
  };
  setErr('');

  wrap.querySelector('#mntMachRenameBtn')?.addEventListener('click', async () => {
    setErr('');
    const oldCode = ex.machine_code;
    // eslint-disable-next-line no-alert
    const proposed = prompt(
      `Preimenuj šifru mašine "${oldCode}" u:\n\n(atomski menja sve maint_* tabele)`,
      oldCode,
    );
    if (proposed == null) return;
    const newCode = String(proposed).trim();
    if (!newCode) { setErr('Nova šifra je obavezna.'); return; }
    if (newCode === oldCode) { setErr('Nova šifra mora biti različita.'); return; }
    // eslint-disable-next-line no-alert
    if (!confirm(`POTVRDI: preimenovati "${oldCode}" → "${newCode}"?\n\nOva promena je transakciona i prepisuje machine_code u svim maint_* tabelama.`)) {
      return;
    }
    const btn = wrap.querySelector('#mntMachRenameBtn');
    btn.disabled = true;
    btn.textContent = '…';
    const res = await renameMaintMachine(oldCode, newCode);
    btn.disabled = false;
    btn.textContent = 'Promeni šifru…';
    if (!res.ok) {
      setErr(res.error || 'Preimenovanje nije uspelo.');
      return;
    }
    const r = res.result || {};
    showToast(`✅ Preimenovano: tasks ${r.tasks ?? 0}, incidenti ${r.incidents ?? 0}, napomene ${r.notes ?? 0}`);
    close();
    opts.onSaved?.();
  });

  wrap.querySelector('#mntMachDlgForm')?.addEventListener('submit', async ev => {
    ev.preventDefault();
    setErr('');
    const code = wrap.querySelector('#mntMachCode').value.trim();
    const name = wrap.querySelector('#mntMachName').value.trim();
    if (!code) { setErr('Šifra je obavezna.'); return; }
    if (!name) { setErr('Naziv je obavezan.'); return; }
    const payload = {
      machine_code: code,
      name,
      type: wrap.querySelector('#mntMachType').value.trim() || null,
      manufacturer: wrap.querySelector('#mntMachMfr').value.trim() || null,
      model: wrap.querySelector('#mntMachModel').value.trim() || null,
      serial_number: wrap.querySelector('#mntMachSerial').value.trim() || null,
      year_of_manufacture: wrap.querySelector('#mntMachYearMfr').value
        ? Number(wrap.querySelector('#mntMachYearMfr').value) : null,
      year_commissioned: wrap.querySelector('#mntMachYearCom').value
        ? Number(wrap.querySelector('#mntMachYearCom').value) : null,
      location: wrap.querySelector('#mntMachLoc').value.trim() || null,
      power_kw: wrap.querySelector('#mntMachPower').value
        ? Number(wrap.querySelector('#mntMachPower').value) : null,
      weight_kg: wrap.querySelector('#mntMachWeight').value
        ? Number(wrap.querySelector('#mntMachWeight').value) : null,
      notes: wrap.querySelector('#mntMachNotes').value.trim() || null,
      tracked: wrap.querySelector('#mntMachTracked').checked,
    };
    const btn = wrap.querySelector('#mntMachDlgSave');
    btn.disabled = true;
    if (isEdit) {
      delete payload.machine_code;
      const ok = await patchMaintMachine(ex.machine_code, payload);
      if (!ok) {
        btn.disabled = false;
        setErr('Snimanje nije uspelo (ovlašćenja ili validacija).');
        return;
      }
      showToast('✅ Sačuvano');
    } else {
      const row = await insertMaintMachine({ ...payload, source: 'manual' });
      if (!row) {
        btn.disabled = false;
        setErr('Kreiranje nije uspelo (možda već postoji šifra ili nemaš ovlašćenje).');
        return;
      }
      showToast('✅ Dodato');
    }
    close();
    opts.onSaved?.();
  });
}

/* ── Modal: import iz BigTehn cache-a ──────────────────────────────────── */

/**
 * @param {{ onImported?: ()=>void }} opts
 */
export async function openMaintMachinesImportDialog(opts) {
  const wrap = document.createElement('div');
  wrap.className = 'kadr-modal-overlay';
  wrap.innerHTML = `
    <div class="kadr-modal" style="max-width:640px">
      <div class="kadr-modal-title">Uvezi mašine iz BigTehn-a</div>
      <div class="kadr-modal-subtitle">Prikazuju se samo šifre kojih još nema u katalogu. „Ne-mašine” (<code>no_procedure=true</code>) sakrivene su po defaultu.</div>
      <div class="kadr-modal-err" id="mntImpErr"></div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <input type="checkbox" id="mntImpIncludeNon">
        <label class="form-label" for="mntImpIncludeNon" style="margin:0">Prikaži i pomoćne operacije (Kontrola, Kooperacija…)</label>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <input class="form-input" id="mntImpFilter" placeholder="Filter (šifra ili naziv)" style="flex:1">
        <button type="button" class="btn" id="mntImpSelAll" style="background:var(--surface3)">Selektuj sve prikazane</button>
        <button type="button" class="btn" id="mntImpSelNone" style="background:var(--surface3)">Poništi</button>
      </div>
      <div id="mntImpListHost" style="max-height:340px;overflow:auto;border:1px solid var(--border);border-radius:6px;padding:8px">
        <p class="mnt-muted">Učitavam…</p>
      </div>
      <div class="kadr-modal-actions" style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
        <span style="flex:1"></span>
        <button type="button" class="btn" id="mntImpCancel" style="background:var(--surface3)">Zatvori</button>
        <button type="button" class="btn" id="mntImpGo">Uvezi</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  const close = () => wrap.remove();
  wrap.querySelector('#mntImpCancel')?.addEventListener('click', close);
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });

  const errEl = wrap.querySelector('#mntImpErr');
  const setErr = msg => {
    errEl.textContent = msg || '';
    errEl.style.display = msg ? 'block' : 'none';
  };
  setErr('');

  const listHost = wrap.querySelector('#mntImpListHost');
  const filterInp = wrap.querySelector('#mntImpFilter');
  const includeNonInp = wrap.querySelector('#mntImpIncludeNon');

  /** @type {Array<{machine_code:string,name:string,no_procedure:boolean}>} */
  let all = [];

  async function reload() {
    listHost.innerHTML = `<p class="mnt-muted">Učitavam…</p>`;
    const rows = await fetchMaintMachinesImportable({
      onlyMachining: !includeNonInp.checked,
    });
    if (rows === null) {
      listHost.innerHTML = `<p class="mnt-muted">Ne mogu da učitam listu (RLS ili migracija).</p>`;
      all = [];
      return;
    }
    all = Array.isArray(rows) ? rows : [];
    render();
  }

  function render() {
    const q = filterInp.value.trim().toLowerCase();
    const filtered = q
      ? all.filter(r => (r.machine_code + ' ' + (r.name || '')).toLowerCase().includes(q))
      : all;
    if (!filtered.length) {
      listHost.innerHTML = `<p class="mnt-muted">Nema kandidata (sve je već uvezeno ili filter ne odgovara).</p>`;
      return;
    }
    listHost.innerHTML = filtered
      .map(
        r => `<label style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px dashed var(--border)">
          <input type="checkbox" value="${escAttr(r.machine_code)}" data-mnt-imp-cb>
          <code>${escHtml(r.machine_code)}</code>
          <span>${escHtml(r.name || '')}</span>
          ${r.no_procedure ? '<span class="mnt-badge" style="margin-left:auto" title="U BigTehn-u označena kao no_procedure (pomoćna operacija)">no_procedure</span>' : ''}
        </label>`,
      )
      .join('');
  }

  includeNonInp.addEventListener('change', reload);
  filterInp.addEventListener('input', render);
  wrap.querySelector('#mntImpSelAll')?.addEventListener('click', () => {
    listHost.querySelectorAll('[data-mnt-imp-cb]').forEach(cb => { cb.checked = true; });
  });
  wrap.querySelector('#mntImpSelNone')?.addEventListener('click', () => {
    listHost.querySelectorAll('[data-mnt-imp-cb]').forEach(cb => { cb.checked = false; });
  });

  wrap.querySelector('#mntImpGo')?.addEventListener('click', async () => {
    setErr('');
    const selected = Array.from(
      listHost.querySelectorAll('[data-mnt-imp-cb]:checked'),
    ).map(el => el.value);
    if (!selected.length) {
      setErr('Odaberi bar jednu mašinu za uvoz.');
      return;
    }
    const btn = wrap.querySelector('#mntImpGo');
    btn.disabled = true;
    btn.textContent = '…';
    const imported = await importMaintMachinesFromCache(selected);
    btn.disabled = false;
    btn.textContent = 'Uvezi';
    showToast(`✅ Uvezeno: ${imported}`);
    opts.onImported?.();
    reload();
  });

  await reload();
}

/* ── Modal: TRAJNO brisanje mašine (admin/menadzment) ─────────────────── */

/**
 * Modal sa upozorenjem, brojačem povezanih redova i obaveznim razlogom.
 * Po potvrdi: poziva `deleteMaintMachineHard` (snapshot + cascade DB delete +
 * Storage cleanup + audit log).
 *
 * @param {{ machine: object, filesCount: number, onDeleted?: ()=>void }} opts
 */
export function openMaintMachineDeleteDialog(opts) {
  const m = opts.machine || {};
  const code = m.machine_code || '';
  const wrap = document.createElement('div');
  wrap.className = 'kadr-modal-overlay';
  wrap.innerHTML = `
    <div class="kadr-modal" style="max-width:560px">
      <div class="kadr-modal-title" style="color:#ff6b6b">⚠ Trajno brisanje mašine</div>
      <div class="kadr-modal-subtitle">
        <code>${escHtml(code)}</code> — <strong>${escHtml(m.name || '')}</strong>
        ${m.manufacturer ? ` · ${escHtml(m.manufacturer)}` : ''}${m.model ? ` ${escHtml(m.model)}` : ''}
      </div>
      <div class="kadr-modal-err" id="mntDelErr"></div>
      <div style="background:#3a1414;border:1px solid #5a1d1d;border-radius:6px;padding:12px;margin-bottom:12px;color:#ffb3b3">
        <p style="margin:0 0 6px"><strong>Ova akcija je nepovratna.</strong></p>
        <p style="margin:0;font-size:13px">Brišu se: red iz katalogа, svi <em>incidenti</em>, <em>checks</em>, <em>tasks</em>, <em>napomene</em>, <em>dokumenti</em> (uključujući fajlove iz Storage-a) i <em>override status</em> za ovu mašinu.</p>
        <p style="margin:6px 0 0;font-size:13px">Audit zapis (snapshot + ko/kada/zašto) ostaje u <code>maint_machines_deletion_log</code>.</p>
      </div>
      ${opts.filesCount > 0
        ? `<p style="margin:0 0 8px;font-size:13px">📎 Trenutno ima <strong>${opts.filesCount}</strong> dokument(a) — biće obrisani uključujući fajlove iz Storage bucket-a.</p>`
        : ''}
      <p style="margin:0 0 6px;font-size:13px">Ako nisi siguran/sigurna — koristi <strong>Arhiviraj</strong> (soft-delete, lako se vraća).</p>
      <form id="mntDelForm">
        <label class="form-label" for="mntDelReason">Razlog brisanja * <span class="form-hint" style="font-weight:normal">(min 5 karaktera, čuva se u audit log)</span></label>
        <textarea class="form-input" id="mntDelReason" rows="3" required minlength="5" maxlength="500"
          placeholder="npr. Mašina rashodovana 2024 — premeštena u staro skladište. Uneo: NJ."></textarea>
        <label style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:13px">
          <input type="checkbox" id="mntDelConfirm">
          <span>Razumem, želim <strong>trajno</strong> da obrišem mašinu <code>${escHtml(code)}</code></span>
        </label>
        <div class="kadr-modal-actions" style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
          <span style="flex:1"></span>
          <button type="button" class="btn" id="mntDelCancel" style="background:var(--surface3)">Otkaži</button>
          <button type="submit" class="btn" id="mntDelGo" disabled
            style="background:#5a1d1d;color:#ffb3b3;border:1px solid #7a2828">Obriši trajno</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(wrap);

  const close = () => wrap.remove();
  wrap.querySelector('#mntDelCancel')?.addEventListener('click', close);
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });

  const errEl = wrap.querySelector('#mntDelErr');
  const setErr = msg => {
    errEl.textContent = msg || '';
    errEl.style.display = msg ? 'block' : 'none';
  };
  setErr('');

  const reasonEl = /** @type {HTMLTextAreaElement} */ (wrap.querySelector('#mntDelReason'));
  const confirmEl = /** @type {HTMLInputElement} */ (wrap.querySelector('#mntDelConfirm'));
  const goBtn = /** @type {HTMLButtonElement} */ (wrap.querySelector('#mntDelGo'));
  function refreshGo() {
    goBtn.disabled = !(confirmEl.checked && reasonEl.value.trim().length >= 5);
  }
  reasonEl.addEventListener('input', refreshGo);
  confirmEl.addEventListener('change', refreshGo);

  wrap.querySelector('#mntDelForm')?.addEventListener('submit', async ev => {
    ev.preventDefault();
    setErr('');
    if (goBtn.disabled) return;
    goBtn.disabled = true;
    goBtn.textContent = 'Brišem…';
    const res = await deleteMaintMachineHard(code, reasonEl.value.trim());
    if (!res.ok) {
      goBtn.disabled = false;
      goBtn.textContent = 'Obriši trajno';
      setErr(res.error || 'Brisanje nije uspelo.');
      return;
    }
    if (res.storageFailures) {
      showToast(`⚠ DB obrisan, ali ${res.storageFailures} Storage fajl(a) nije uspelo da se ukloni`);
    }
    close();
    opts.onDeleted?.();
  });
}

/* ── Modal: dokumenti uz mašinu (reuse renderMaintFilesTab) ─────────────── */

/**
 * Otvara modal sa kompletnim file managementom (upload, preview, delete, edit
 * metapodataka). Reuse-uje `renderMaintFilesTab` iz tab-a u detalju mašine
 * tako da imamo jedno mesto istine za UX.
 *
 * @param {{ machineCode: string, machineName?: string, prof: object|null,
 *           archived?: boolean, onChanged?: ()=>void }} opts
 */
export function openMaintMachineDocsDialog(opts) {
  const wrap = document.createElement('div');
  wrap.className = 'kadr-modal-overlay';
  wrap.innerHTML = `
    <div class="kadr-modal" style="max-width:760px;max-height:90vh;display:flex;flex-direction:column">
      <div class="kadr-modal-title">📎 Dokumenti — <code>${escHtml(opts.machineCode)}</code> ${opts.machineName ? `· ${escHtml(opts.machineName)}` : ''}</div>
      <div class="kadr-modal-subtitle">Uputstva, fotografije, tehnički crteži, servisni izveštaji, garantni listovi.</div>
      <div id="mntDocsHost" style="flex:1;overflow:auto;padding:4px"></div>
      <div class="kadr-modal-actions" style="margin-top:12px;display:flex;gap:8px">
        <span style="flex:1"></span>
        <button type="button" class="btn" id="mntDocsClose" style="background:var(--surface3)">Zatvori</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  const close = () => {
    wrap.remove();
    opts.onChanged?.();
  };
  wrap.querySelector('#mntDocsClose')?.addEventListener('click', close);
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });

  const host = wrap.querySelector('#mntDocsHost');
  renderMaintFilesTab(host, opts.machineCode, opts.prof, {
    archived: opts.archived,
    onChanged: opts.onChanged,
  });
}

/* ── Modal: audit log trajnih brisanja ────────────────────────────────── */

function fmtCounts(c) {
  if (!c || typeof c !== 'object') return '';
  const parts = [];
  if (c.tasks)     parts.push(`${c.tasks} task(s)`);
  if (c.checks)    parts.push(`${c.checks} check(s)`);
  if (c.incidents) parts.push(`${c.incidents} incid.`);
  if (c.notes)     parts.push(`${c.notes} napom.`);
  if (c.files)     parts.push(`${c.files} dok.`);
  if (c.override)  parts.push(`${c.override} override`);
  return parts.join(' · ');
}

function fmtSnapshot(snap) {
  if (!snap || typeof snap !== 'object') return '';
  const fields = [
    ['type', 'Tip'],
    ['manufacturer', 'Proizvođač'],
    ['model', 'Model'],
    ['serial_number', 'Serijski'],
    ['year_of_manufacture', 'Godina proiz.'],
    ['year_commissioned', 'Godina pogon'],
    ['location', 'Lokacija'],
    ['power_kw', 'kW'],
    ['weight_kg', 'kg'],
    ['notes', 'Napomene'],
  ];
  const parts = fields
    .filter(([k]) => snap[k] != null && snap[k] !== '')
    .map(([k, lab]) => `<div><span class="mnt-muted" style="font-size:11px">${lab}:</span> ${escHtml(String(snap[k]))}</div>`);
  return parts.length
    ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:6px;font-size:12px">${parts.join('')}</div>`
    : '<p class="mnt-muted" style="font-size:12px;margin-top:6px">(snimak je bio prazan)</p>';
}

/**
 * Modal sa listom svih trajno obrisanih mašina (audit log). Read-only.
 */
export function openMaintDeletionLogDialog() {
  const wrap = document.createElement('div');
  wrap.className = 'kadr-modal-overlay';
  wrap.innerHTML = `
    <div class="kadr-modal" style="max-width:820px;max-height:90vh;display:flex;flex-direction:column">
      <div class="kadr-modal-title">📋 Istorija brisanja mašina</div>
      <div class="kadr-modal-subtitle">Pun snapshot reda iz katalogа u trenutku brisanja, razlog, ko je i kada obrisao. Vidljivo za chief/admin/menadzment.</div>
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <input class="form-input" id="mntHistFilter" placeholder="Filter (šifra, naziv, email, razlog)" style="flex:1">
      </div>
      <div id="mntHistHost" style="flex:1;overflow:auto;border:1px solid var(--border);border-radius:6px;padding:8px">
        <p class="mnt-muted">Učitavam…</p>
      </div>
      <div class="kadr-modal-actions" style="margin-top:12px;display:flex;gap:8px">
        <span style="flex:1"></span>
        <button type="button" class="btn" id="mntHistClose" style="background:var(--surface3)">Zatvori</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  const close = () => wrap.remove();
  wrap.querySelector('#mntHistClose')?.addEventListener('click', close);
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });

  const host = wrap.querySelector('#mntHistHost');
  const filterEl = /** @type {HTMLInputElement} */ (wrap.querySelector('#mntHistFilter'));

  /** @type {Array<any>} */
  let all = [];

  function render() {
    const q = filterEl.value.trim().toLowerCase();
    const list = q
      ? all.filter(r => {
          const hay = [r.machine_code, r.machine_name, r.deleted_by_email, r.reason]
            .filter(Boolean).join(' ').toLowerCase();
          return hay.includes(q);
        })
      : all;
    if (!list.length) {
      host.innerHTML = `<p class="mnt-muted">Nema obrisanih mašina${q ? ' (za filter)' : ''}.</p>`;
      return;
    }
    host.innerHTML = list.map(r => {
      const ts = r.deleted_at ? new Date(r.deleted_at).toLocaleString('sr-Latn-RS') : '';
      const counts = fmtCounts(r.related_counts);
      return `
        <div style="border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:8px;background:var(--surface)">
          <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:baseline">
            <code style="font-weight:600">${escHtml(r.machine_code || '')}</code>
            <span style="font-weight:600">${escHtml(r.machine_name || '')}</span>
            <span style="flex:1"></span>
            <span class="mnt-muted" style="font-size:12px">${escHtml(ts)}</span>
          </div>
          <div class="mnt-muted" style="font-size:12px;margin-top:4px">
            obrisao: <strong>${escHtml(r.deleted_by_email || '—')}</strong>${counts ? ` · kaskadno: ${escHtml(counts)}` : ''}
          </div>
          <div style="margin-top:6px;padding:6px 8px;background:var(--surface2);border-left:3px solid var(--red);border-radius:3px;font-size:13px;white-space:pre-wrap">
            ${escHtml(r.reason || '')}
          </div>
          <details style="margin-top:6px">
            <summary class="mnt-muted" style="font-size:12px;cursor:pointer">Snapshot mašine</summary>
            ${fmtSnapshot(r.snapshot)}
          </details>
        </div>`;
    }).join('');
  }

  filterEl.addEventListener('input', render);

  fetchMaintMachineDeletionLog({ limit: 500 }).then(rows => {
    if (rows === null) {
      host.innerHTML = `<p class="mnt-muted">Ne mogu da učitam log (RLS ili migracija nije primenjena).</p>`;
      return;
    }
    all = Array.isArray(rows) ? rows : [];
    render();
  }).catch(() => {
    host.innerHTML = `<p class="mnt-muted">Greška pri učitavanju log-a.</p>`;
  });
}
