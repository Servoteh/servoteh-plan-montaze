/**
 * Kadrovska — TAB „Zarade" (Faza K3 + K3.2, samo admin).
 *
 * Sub-tabovi (persistiraju u localStorage pod `pm_salary_subtab`):
 *   - 📜 Uslovi zarade   (salary_terms — ugovor/dogovor/satnica + prevoz + dnevnice)
 *   - 🧾 Mesečni obračun (salary_payroll — prvi deo, sati, dnevnice, drugi deo)
 *
 * RLS: sve je samo admin (FE + DB). HR i ostali ne vide ovaj tab uopšte.
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { formatDate } from '../../lib/date.js';
import { canAccessSalary, getIsOnline } from '../../state/auth.js';
import { hasSupabaseConfig } from '../../lib/constants.js';
import {
  kadrovskaState,
  kadrSalaryState,
} from '../../state/kadrovska.js';
import {
  ensureEmployeesLoaded,
  ensureCurrentSalariesLoaded,
  ensureTermsForEmployee,
} from '../../services/kadrovska.js';
import {
  saveTermToDb,
  updateTermInDb,
  deleteTermFromDb,
} from '../../services/salary.js';
import { renderSummaryChips } from './shared.js';
import { loadXlsx } from '../../lib/xlsx.js';
import {
  renderPayrollSubtab,
  wirePayrollSubtab,
} from './salaryPayrollTab.js';

const SUBTAB_KEY = 'pm_salary_subtab';
const VALID_SUBTABS = new Set(['terms', 'payroll']);

let subtabRoot = null;
let termsRoot = null;

function readSubtab() {
  try {
    const v = localStorage.getItem(SUBTAB_KEY);
    return VALID_SUBTABS.has(v) ? v : 'terms';
  } catch { return 'terms'; }
}
function writeSubtab(id) {
  try { localStorage.setItem(SUBTAB_KEY, id); } catch {}
}

/* ── HELPERS ──────────────────────────────────────────────────── */

function fmtMoney(amount, currency) {
  if (amount == null || isNaN(Number(amount))) return '—';
  const n = Number(amount);
  const s = n.toLocaleString('sr-RS', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return `${s} ${currency || 'RSD'}`;
}

function salaryTypeLabel(t) {
  switch (t) {
    case 'ugovor': return 'Ugovor (mesečno)';
    case 'dogovor': return 'Dogovor (mesečno)';
    case 'satnica': return 'Satnica';
    default: return t || '—';
  }
}

/* ── ROOT RENDER + DISPATCH ────────────────────────────────────── */

export function renderSalaryTab() {
  if (!canAccessSalary()) {
    return `
      <section class="kadr-panel-inner" aria-label="Zarade">
        <div class="kadr-empty" style="margin:40px 24px">
          <div class="kadrovska-empty-title">🔒 Pristup zabranjen</div>
          <div>Zaradama pristupa isključivo administrator.</div>
        </div>
      </section>`;
  }
  const sub = readSubtab();
  return `
    <div class="kadr-subtab-strip" role="tablist" aria-label="Zarade">
      <button class="kadr-subtab ${sub === 'terms' ? 'active' : ''}" data-sub="terms" role="tab" aria-selected="${sub === 'terms'}">📜 Uslovi zarade</button>
      <button class="kadr-subtab ${sub === 'payroll' ? 'active' : ''}" data-sub="payroll" role="tab" aria-selected="${sub === 'payroll'}">🧾 Mesečni obračun</button>
    </div>
    <div id="salarySubPanel" role="tabpanel"></div>
  `;
}

export async function wireSalaryTab(panelEl) {
  if (!canAccessSalary()) return;
  subtabRoot = panelEl;
  panelEl.querySelectorAll('.kadr-subtab').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.sub;
      if (!VALID_SUBTABS.has(id)) return;
      writeSubtab(id);
      panelEl.querySelectorAll('.kadr-subtab').forEach(b => {
        const act = b.dataset.sub === id;
        b.classList.toggle('active', act);
        b.setAttribute('aria-selected', String(act));
      });
      mountSubPanel(id);
    });
  });
  mountSubPanel(readSubtab());
}

function mountSubPanel(id) {
  if (!subtabRoot) return;
  const host = subtabRoot.querySelector('#salarySubPanel');
  if (!host) return;
  if (id === 'payroll') {
    host.innerHTML = renderPayrollSubtab();
    Promise.resolve().then(() => wirePayrollSubtab(host)).catch(e => {
      console.error('[salary/payroll] wire', e);
      showToast('⚠ Greška pri učitavanju obračuna');
    });
    return;
  }
  host.innerHTML = renderTermsSubtab();
  termsRoot = host;
  Promise.resolve().then(() => wireTermsSubtab(host)).catch(e => {
    console.error('[salary/terms] wire', e);
    showToast('⚠ Greška pri učitavanju uslova');
  });
}

/* ══════════════════════════════════════════════════════════════════
   SUB-TAB „USLOVI ZARADE" (salary_terms)
   ════════════════════════════════════════════════════════════════════ */

function renderTermsSubtab() {
  return `
    <div class="kadr-summary-strip" id="salSummary"></div>
    <div class="kadrovska-toolbar">
      <input type="text" class="kadrovska-search" id="salSearch" placeholder="Pretraga po imenu, poziciji…">
      <select class="kadrovska-filter" id="salTypeFilter">
        <option value="">Svi tipovi</option>
        <option value="ugovor">Ugovor</option>
        <option value="dogovor">Dogovor</option>
        <option value="satnica">Satnica</option>
      </select>
      <select class="kadrovska-filter" id="salStatusFilter">
        <option value="active" selected>Samo aktivni</option>
        <option value="all">Svi</option>
      </select>
      <div class="kadrovska-toolbar-spacer"></div>
      <button class="btn btn-ghost" id="salExport">📊 Excel</button>
      <button class="btn btn-primary" id="salNewBtn">+ Novi unos zarade</button>
    </div>
    <main class="kadrovska-main">
      <table class="kadrovska-table" id="salTable">
        <thead>
          <tr>
            <th>Zaposleni</th>
            <th class="col-hide-sm">Pozicija / Odeljenje</th>
            <th>Tip</th>
            <th>Iznos / satnica</th>
            <th class="col-hide-sm">Prevoz</th>
            <th class="col-hide-sm">Dinarska dnev.</th>
            <th class="col-hide-sm">Devizna dnev.</th>
            <th class="col-hide-sm">Važi od</th>
            <th class="col-actions">Akcije</th>
          </tr>
        </thead>
        <tbody id="salTbody"></tbody>
      </table>
      <div class="kadrovska-empty" id="salEmpty" style="display:none;margin-top:16px;">
        <div class="kadrovska-empty-title">Nema upisanih zarada</div>
        <div>Klikni <strong>+ Novi unos zarade</strong> da dodaš prvi zapis.</div>
      </div>
    </main>`;
}

async function wireTermsSubtab(panelEl) {
  panelEl.querySelector('#salSearch').addEventListener('input', refreshTerms);
  panelEl.querySelector('#salTypeFilter').addEventListener('change', refreshTerms);
  panelEl.querySelector('#salStatusFilter').addEventListener('change', refreshTerms);
  panelEl.querySelector('#salNewBtn').addEventListener('click', () => openTermModal(null, null));
  panelEl.querySelector('#salExport').addEventListener('click', exportTermsXlsx);

  await Promise.all([
    ensureEmployeesLoaded(),
    ensureCurrentSalariesLoaded(true),
  ]);
  refreshTerms();
}

function refreshTerms() {
  if (!termsRoot || !canAccessSalary()) return;
  const q = (termsRoot.querySelector('#salSearch').value || '').trim().toLowerCase();
  const typeF = termsRoot.querySelector('#salTypeFilter').value;
  const statF = termsRoot.querySelector('#salStatusFilter').value;

  const byEmp = new Map(kadrSalaryState.current.map(s => [s.employeeId, s]));
  const emps = kadrovskaState.employees.filter(e => {
    if (statF === 'active' && !e.isActive) return false;
    if (q) {
      const hay = [e.fullName, e.firstName, e.lastName, e.position, e.department].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (typeF) {
      const s = byEmp.get(e.id);
      if (!s || s.salaryType !== typeF) return false;
    }
    return true;
  });

  const tbody = termsRoot.querySelector('#salTbody');
  const empty = termsRoot.querySelector('#salEmpty');
  const withSalary = emps.filter(e => byEmp.has(e.id));
  const without = emps.filter(e => !byEmp.has(e.id));

  renderSummaryChips('salSummary', [
    { label: 'Sa aktivnom zaradom', value: withSalary.length, tone: 'accent' },
    { label: 'Bez zarade', value: without.length, tone: without.length ? 'warn' : 'muted' },
    { label: 'Ugovor', value: kadrSalaryState.current.filter(s => s.salaryType === 'ugovor').length, tone: 'muted' },
    { label: 'Dogovor', value: kadrSalaryState.current.filter(s => s.salaryType === 'dogovor').length, tone: 'muted' },
    { label: 'Satnica', value: kadrSalaryState.current.filter(s => s.salaryType === 'satnica').length, tone: 'muted' },
  ]);

  if (!emps.length) {
    tbody.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  emps.sort((a, b) => String(a.fullName || '').localeCompare(String(b.fullName || ''), 'sr'));

  tbody.innerHTML = emps.map(e => {
    const s = byEmp.get(e.id);
    const posDept = [e.position, e.department].filter(Boolean).join(' / ');
    const typeBadge = s
      ? `<span class="kadr-type-badge t-sal-${escHtml(s.salaryType)}">${escHtml(salaryTypeLabel(s.salaryType))}</span>`
      : `<span class="kadr-type-badge t-ostalo">—</span>`;
    const amountTxt = s
      ? `<strong>${escHtml(fmtMoney(s.amount, s.currency))}</strong> <small class="emp-sub">${escHtml(s.amountType)}</small>${s.salaryType === 'satnica' ? ' <small>/h</small>' : ''}`
      : `<em class="emp-sub">nema</em>`;
    const transport = s?.transportAllowanceRsd ? escHtml(fmtMoney(s.transportAllowanceRsd, 'RSD')) : '<em class="emp-sub">0</em>';
    const perDiemRsd = s?.perDiemRsd ? escHtml(fmtMoney(s.perDiemRsd, 'RSD')) : '<em class="emp-sub">0</em>';
    const perDiemEur = s?.perDiemEur ? `${escHtml(String(s.perDiemEur))} EUR` : '<em class="emp-sub">0</em>';
    const fromTxt = s?.effectiveFrom ? formatDate(s.effectiveFrom) : '—';
    return `<tr data-emp-id="${escHtml(e.id)}" data-term-id="${escHtml(s?.salaryTermId || '')}">
      <td><div class="emp-name">${escHtml(e.fullName || '—')}</div></td>
      <td class="col-hide-sm">${escHtml(posDept || '—')}</td>
      <td>${typeBadge}</td>
      <td>${amountTxt}</td>
      <td class="col-hide-sm">${transport}</td>
      <td class="col-hide-sm">${perDiemRsd}</td>
      <td class="col-hide-sm">${perDiemEur}</td>
      <td class="col-hide-sm">${fromTxt}</td>
      <td class="col-actions">
        <button class="btn-row-act" data-act="history" data-emp-id="${escHtml(e.id)}">📜 Istorija</button>
        <button class="btn-row-act" data-act="new" data-emp-id="${escHtml(e.id)}">+ Novi</button>
      </td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('button[data-act="history"]').forEach(b => {
    b.addEventListener('click', () => openHistoryModal(b.dataset.empId));
  });
  tbody.querySelectorAll('button[data-act="new"]').forEach(b => {
    b.addEventListener('click', () => openTermModal(null, b.dataset.empId));
  });
}

/* ── TERM MODAL (novi / izmena) — prošireno prevoz + dnevnice ─── */

function buildTermModalHtml(term, empId) {
  const isEdit = !!term;
  const empOpts = kadrovskaState.employees
    .slice()
    .sort((a, b) => String(a.fullName || '').localeCompare(String(b.fullName || ''), 'sr'))
    .map(e => `<option value="${escHtml(e.id)}"${(empId === e.id || term?.employeeId === e.id) ? ' selected' : ''}>${escHtml(e.fullName || '—')}</option>`)
    .join('');

  const todayIso = new Date().toISOString().slice(0, 10);
  return `
    <div class="emp-modal-overlay" id="salModal" role="dialog" aria-modal="true">
      <div class="emp-modal emp-modal-wide">
        <div class="emp-modal-title">${isEdit ? 'Izmeni unos zarade' : 'Novi unos zarade'}</div>
        <div class="emp-modal-subtitle">Istorijski zapis. Novi „važi od“ datum automatski zatvara prethodni aktivan red.</div>
        <div class="emp-modal-err" id="salErr"></div>
        <form id="salForm">
          <input type="hidden" id="salId" value="${escHtml(term?.id || '')}">
          <fieldset class="emp-section">
            <legend>Osnovni ugovorni uslovi</legend>
            <div class="emp-form-grid">
              <div class="emp-field col-full">
                <label for="salEmp">Zaposleni *</label>
                <select id="salEmp" required ${isEdit ? 'disabled' : ''}>
                  <option value="">— izaberi —</option>
                  ${empOpts}
                </select>
              </div>
              <div class="emp-field">
                <label for="salType">Tip *</label>
                <select id="salType" required>
                  <option value="ugovor"${term?.salaryType === 'ugovor' ? ' selected' : ''}>Ugovor (mesečno)</option>
                  <option value="dogovor"${term?.salaryType === 'dogovor' ? ' selected' : ''}>Dogovor (mesečno)</option>
                  <option value="satnica"${term?.salaryType === 'satnica' ? ' selected' : ''}>Satnica</option>
                </select>
              </div>
              <div class="emp-field">
                <label for="salAmountType">Neto / Bruto *</label>
                <select id="salAmountType" required>
                  <option value="neto"${(term?.amountType || 'neto') === 'neto' ? ' selected' : ''}>Neto</option>
                  <option value="bruto"${term?.amountType === 'bruto' ? ' selected' : ''}>Bruto</option>
                </select>
              </div>
              <div class="emp-field">
                <label for="salAmount">Iznos / satnica *</label>
                <input type="number" id="salAmount" min="0" step="0.01" required value="${term?.amount != null ? term.amount : ''}">
              </div>
              <div class="emp-field">
                <label for="salCurrency">Valuta</label>
                <select id="salCurrency">
                  <option value="RSD"${(term?.currency || 'RSD') === 'RSD' ? ' selected' : ''}>RSD</option>
                  <option value="EUR"${term?.currency === 'EUR' ? ' selected' : ''}>EUR</option>
                  <option value="USD"${term?.currency === 'USD' ? ' selected' : ''}>USD</option>
                </select>
              </div>
              <div class="emp-field">
                <label for="salFrom">Važi od *</label>
                <input type="date" id="salFrom" required value="${escHtml(term?.effectiveFrom || todayIso)}">
              </div>
              <div class="emp-field">
                <label for="salTo">Važi do (opc.)</label>
                <input type="date" id="salTo" value="${escHtml(term?.effectiveTo || '')}">
              </div>
              <div class="emp-field col-full">
                <label for="salRef">Broj / referenca ugovora</label>
                <input type="text" id="salRef" maxlength="120" value="${escHtml(term?.contractRef || '')}">
              </div>
            </div>
          </fieldset>

          <fieldset class="emp-section">
            <legend>Mesečni dodaci (obračun zarade)</legend>
            <div class="emp-form-help">
              Polja ispod se koriste kao <strong>podrazumevane</strong> vrednosti pri kreiranju mesečnog obračuna.
              Mogu se menjati individualno u tabu „Mesečni obračun". Ostavi <code>0</code> ako zaposleni nema to pravo.
            </div>
            <div class="emp-form-grid">
              <div class="emp-field">
                <label for="salTransport">Prevoz (RSD mesečno)</label>
                <input type="number" id="salTransport" min="0" step="0.01" value="${term?.transportAllowanceRsd || 0}" placeholder="0 = organizovan prevoz">
              </div>
              <div class="emp-field">
                <label for="salDiemRsd">Dinarska dnevnica (RSD / teren)</label>
                <input type="number" id="salDiemRsd" min="0" step="0.01" value="${term?.perDiemRsd || 0}">
              </div>
              <div class="emp-field">
                <label for="salDiemEur">Devizna dnevnica (EUR / teren ino)</label>
                <input type="number" id="salDiemEur" min="0" step="0.01" value="${term?.perDiemEur || 0}">
              </div>
            </div>
          </fieldset>

          <fieldset class="emp-section">
            <legend>Napomena</legend>
            <div class="emp-form-grid">
              <div class="emp-field col-full">
                <textarea id="salNote" maxlength="1000" rows="2">${escHtml(term?.note || '')}</textarea>
              </div>
            </div>
          </fieldset>

          <div class="emp-modal-actions">
            <button type="button" class="btn" id="salCancel">Otkaži</button>
            <button type="submit" class="btn btn-primary" id="salSubmit">Sačuvaj</button>
          </div>
        </form>
      </div>
    </div>`;
}

function closeTermModal() {
  document.getElementById('salModal')?.remove();
}

function openTermModal(term, employeeId) {
  if (!canAccessSalary()) return;
  closeTermModal();
  const wrap = document.createElement('div');
  wrap.innerHTML = buildTermModalHtml(term, employeeId);
  document.body.appendChild(wrap.firstElementChild);
  const m = document.getElementById('salModal');
  m.querySelector('#salCancel').addEventListener('click', closeTermModal);
  m.querySelector('#salForm').addEventListener('submit', (e) => {
    e.preventDefault();
    submitTerm();
  });
  m.addEventListener('click', (e) => { if (e.target === m) closeTermModal(); });
  setTimeout(() => m.querySelector('#salAmount')?.focus(), 50);
}

async function submitTerm() {
  const err = document.getElementById('salErr');
  err.textContent = ''; err.classList.remove('visible');
  const id = document.getElementById('salId').value || null;
  const empId = document.getElementById('salEmp').value;
  const salaryType = document.getElementById('salType').value;
  const amountType = document.getElementById('salAmountType').value;
  const amount = parseFloat(document.getElementById('salAmount').value);
  const currency = document.getElementById('salCurrency').value;
  const effectiveFrom = document.getElementById('salFrom').value;
  const effectiveTo = document.getElementById('salTo').value || null;
  const contractRef = document.getElementById('salRef').value.trim();
  const note = document.getElementById('salNote').value.trim();
  const transportAllowanceRsd = parseFloat(document.getElementById('salTransport').value) || 0;
  const perDiemRsd = parseFloat(document.getElementById('salDiemRsd').value) || 0;
  const perDiemEur = parseFloat(document.getElementById('salDiemEur').value) || 0;

  if (!empId) { err.textContent = 'Izaberi zaposlenog.'; err.classList.add('visible'); return; }
  if (!effectiveFrom) { err.textContent = 'Datum „Važi od“ je obavezan.'; err.classList.add('visible'); return; }
  if (effectiveTo && effectiveTo < effectiveFrom) {
    err.textContent = '"Važi do" ne može biti pre "Važi od".';
    err.classList.add('visible'); return;
  }
  if (!(amount >= 0)) { err.textContent = 'Iznos mora biti broj ≥ 0.'; err.classList.add('visible'); return; }
  if (transportAllowanceRsd < 0 || perDiemRsd < 0 || perDiemEur < 0) {
    err.textContent = 'Prevoz i dnevnice ne mogu biti negativni.';
    err.classList.add('visible'); return;
  }

  const payload = {
    id, employeeId: empId, salaryType, amount, amountType, currency,
    effectiveFrom, effectiveTo, contractRef, note,
    transportAllowanceRsd, perDiemRsd, perDiemEur,
  };

  const btn = document.getElementById('salSubmit');
  btn.disabled = true; btn.textContent = 'Čuvanje…';
  try {
    if (!getIsOnline() || !hasSupabaseConfig()) {
      showToast('⚠ Zarade zahtevaju online konekciju');
      return;
    }
    let res;
    if (id) res = await updateTermInDb(payload);
    else    res = await saveTermToDb(payload);
    if (!res || !res.length) {
      err.textContent = 'Čuvanje nije uspelo. Da li je migracija add_kadr_salary_payroll.sql primenjena i si admin?';
      err.classList.add('visible');
      return;
    }
    kadrSalaryState.termsByEmp.delete(empId);
    await ensureCurrentSalariesLoaded(true);
    closeTermModal();
    refreshTerms();
    showToast(id ? '✏️ Izmenjeno' : '✅ Zarada upisana');
  } catch (e) {
    console.error('[salary] submit', e);
    err.textContent = 'Greška pri čuvanju.';
    err.classList.add('visible');
  } finally {
    btn.disabled = false; btn.textContent = 'Sačuvaj';
  }
}

/* ── HISTORY MODAL ────────────────────────────────────────────── */

async function openHistoryModal(empId) {
  if (!canAccessSalary()) return;
  closeTermModal();
  const emp = kadrovskaState.employees.find(e => e.id === empId);
  const list = await ensureTermsForEmployee(empId, true);

  const rowsHtml = (list || []).length ? `
    <table class="emp-children-table">
      <thead>
        <tr>
          <th>Važi od</th>
          <th>Važi do</th>
          <th>Tip</th>
          <th>Iznos</th>
          <th>Prevoz</th>
          <th>Din. dnev.</th>
          <th>Dev. dnev.</th>
          <th class="col-actions">Akcije</th>
        </tr>
      </thead>
      <tbody>
        ${list.map(t => `
          <tr data-term-id="${escHtml(t.id)}">
            <td>${escHtml(formatDate(t.effectiveFrom) || '—')}</td>
            <td>${t.effectiveTo ? escHtml(formatDate(t.effectiveTo)) : '<em class="emp-sub">aktivno</em>'}</td>
            <td><span class="kadr-type-badge t-sal-${escHtml(t.salaryType)}">${escHtml(salaryTypeLabel(t.salaryType))}</span></td>
            <td>${escHtml(fmtMoney(t.amount, t.currency))}</td>
            <td>${escHtml(fmtMoney(t.transportAllowanceRsd, 'RSD'))}</td>
            <td>${escHtml(fmtMoney(t.perDiemRsd, 'RSD'))}</td>
            <td>${escHtml(String(t.perDiemEur || 0))} EUR</td>
            <td class="col-actions">
              <button class="btn-row-act" data-act="edit" data-term-id="${escHtml(t.id)}">Izmeni</button>
              <button class="btn-row-act danger" data-act="del" data-term-id="${escHtml(t.id)}">Obriši</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  ` : `<div class="kadr-empty" style="padding:20px 0">Nema istorije unosa.</div>`;

  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="emp-modal-overlay" id="salModal" role="dialog">
      <div class="emp-modal emp-modal-wide">
        <div class="emp-modal-title">📜 Istorija zarada — ${escHtml(emp?.fullName || '—')}</div>
        <div class="emp-modal-subtitle">Poslednji aktivan red je trenutno važeći. Svaki „novi unos“ zatvara prethodni aktivan.</div>
        ${rowsHtml}
        <div class="emp-modal-actions">
          <button type="button" class="btn" id="salHistClose">Zatvori</button>
          <button type="button" class="btn btn-primary" id="salHistNew">+ Novi unos</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap.firstElementChild);
  const m = document.getElementById('salModal');
  m.querySelector('#salHistClose').addEventListener('click', closeTermModal);
  m.querySelector('#salHistNew').addEventListener('click', () => {
    closeTermModal();
    openTermModal(null, empId);
  });
  m.addEventListener('click', (e) => { if (e.target === m) closeTermModal(); });
  m.querySelectorAll('button[data-act="edit"]').forEach(b => {
    b.addEventListener('click', () => {
      const t = (list || []).find(x => x.id === b.dataset.termId);
      if (t) { closeTermModal(); openTermModal(t, empId); }
    });
  });
  m.querySelectorAll('button[data-act="del"]').forEach(b => {
    b.addEventListener('click', async () => {
      if (!confirm('Obrisati ovaj unos zarade? Akcija je trajna.')) return;
      const ok = await deleteTermFromDb(b.dataset.termId);
      if (!ok) { showToast('⚠ Brisanje nije uspelo'); return; }
      kadrSalaryState.termsByEmp.delete(empId);
      await ensureCurrentSalariesLoaded(true);
      closeTermModal();
      refreshTerms();
      showToast('🗑 Obrisano');
    });
  });
}

/* ── XLSX (terms) ─────────────────────────────────────────────── */

async function exportTermsXlsx() {
  if (!canAccessSalary()) return;
  const XLSX = await loadXlsx();
  const curMap = new Map(kadrSalaryState.current.map(s => [s.employeeId, s]));
  const aoa = [[
    'Zaposleni', 'Pozicija', 'Odeljenje', 'Tip',
    'Iznos', 'Valuta', 'Neto/Bruto',
    'Prevoz (RSD)', 'Din. dnev. (RSD)', 'Dev. dnev. (EUR)',
    'Važi od', 'Važi do', 'Ugovor br.',
  ]];
  kadrovskaState.employees
    .slice()
    .sort((a, b) => String(a.fullName || '').localeCompare(String(b.fullName || ''), 'sr'))
    .forEach(e => {
      const s = curMap.get(e.id);
      if (!s) return;
      aoa.push([
        e.fullName || '', e.position || '', e.department || '',
        salaryTypeLabel(s.salaryType),
        s.amount, s.currency, s.amountType,
        s.transportAllowanceRsd || 0, s.perDiemRsd || 0, s.perDiemEur || 0,
        s.effectiveFrom || '', s.effectiveTo || '', s.contractRef || '',
      ]);
    });
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 30 }, { wch: 22 }, { wch: 18 }, { wch: 18 }, { wch: 12 }, { wch: 8 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 18 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Uslovi zarade');
  XLSX.writeFile(wb, `Zarade_uslovi_${new Date().toISOString().slice(0, 10)}.xlsx`);
  showToast('📊 Izvezeno');
}
