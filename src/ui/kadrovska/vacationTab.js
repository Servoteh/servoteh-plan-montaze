/**
 * Kadrovska — TAB Godišnji odmor (Faza K2).
 *
 * Prikazuje po izabranoj godini:
 *   - Entitlement po zaposlenom (dana_total default 20, dana_preneto)
 *   - Iskorišćeno (iz absences type='godisnji' i work_hours absence_code='go')
 *   - Preostalo
 *
 * Dozvoljene akcije:
 *   - Inline izmena „Dana pravo“ i „Preneto iz prošle godine“
 *   - Dugme „Generiši rešenje o GO“ — otvara print HTML template sa brojem dana
 *     na osnovu postojećeg `absences` zapisa tipa 'godisnji' za tog zaposlenog.
 *
 * Izveštajni izvoz: Excel preko `loadXlsx` (lazy).
 *
 * Napomena o šemi: koristi `vacation_entitlements` + view `v_vacation_balance`
 * iz migracije `add_kadr_employee_extended.sql`.
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { formatDate } from '../../lib/date.js';
import { canEditKadrovska } from '../../state/auth.js';
import {
  kadrovskaState,
  kadrAbsencesState,
  kadrVacationState,
} from '../../state/kadrovska.js';
import {
  ensureEmployeesLoaded,
  ensureAbsencesLoaded,
  ensureVacationLoaded,
  employeeNameById,
} from '../../services/kadrovska.js';
import {
  saveEntitlementToDb,
  mapDbEntitlement,
  loadBalancesFromDb,
} from '../../services/vacation.js';
import { renderSummaryChips } from './shared.js';
import { loadXlsx } from '../../lib/xlsx.js';

let panelRoot = null;

/* ── HTML ─────────────────────────────────────────────────────────── */

export function renderVacationTab() {
  const curYear = new Date().getFullYear();
  return `
    <div class="kadr-summary-strip" id="vacSummary"></div>
    <div class="kadrovska-toolbar">
      <label class="kadrovska-filter" style="display:flex;gap:6px;align-items:center;">
        <span>Godina</span>
        <input type="number" id="vacYear" min="2000" max="2100" step="1" value="${curYear}" style="max-width:90px">
      </label>
      <input type="text" class="kadrovska-search" id="vacSearch" placeholder="Pretraga po imenu…">
      <select class="kadrovska-filter" id="vacStatusFilter">
        <option value="active" selected>Samo aktivni</option>
        <option value="all">Svi</option>
      </select>
      <div class="kadrovska-toolbar-spacer"></div>
      <button class="btn btn-ghost" id="vacExport">📊 Excel</button>
      <span class="kadrovska-count" id="vacCount">0 zaposlenih</span>
    </div>
    <main class="kadrovska-main">
      <table class="kadrovska-table" id="vacTable">
        <thead>
          <tr>
            <th>Zaposleni</th>
            <th class="col-hide-sm">Odeljenje</th>
            <th>Dana pravo</th>
            <th>Preneto</th>
            <th>Iskorišćeno</th>
            <th>Preostalo</th>
            <th class="col-actions">Rešenje</th>
          </tr>
        </thead>
        <tbody id="vacTbody"></tbody>
      </table>
      <div class="kadrovska-empty" id="vacEmpty" style="display:none;margin-top:16px;">
        <div class="kadrovska-empty-title">Nema zaposlenih</div>
        <div>Dodaj zaposlene u tabu <strong>Zaposleni</strong>.</div>
      </div>
    </main>`;
}

export async function wireVacationTab(panelEl) {
  panelRoot = panelEl;
  const yearEl = panelEl.querySelector('#vacYear');
  yearEl.addEventListener('change', refreshVacationTab);
  panelEl.querySelector('#vacSearch').addEventListener('input', renderRows);
  panelEl.querySelector('#vacStatusFilter').addEventListener('change', renderRows);
  panelEl.querySelector('#vacExport').addEventListener('click', exportToExcel);

  await ensureEmployeesLoaded();
  await ensureAbsencesLoaded();
  await refreshVacationTab();
}

async function refreshVacationTab() {
  if (!panelRoot) return;
  const year = Number(panelRoot.querySelector('#vacYear').value || new Date().getFullYear());
  await ensureVacationLoaded(year, true);
  renderRows();
}

function computeRows() {
  const year = Number(panelRoot.querySelector('#vacYear').value || new Date().getFullYear());
  const statusF = panelRoot.querySelector('#vacStatusFilter').value;
  const q = (panelRoot.querySelector('#vacSearch').value || '').trim().toLowerCase();

  const entByEmp = new Map();
  for (const e of kadrVacationState.entitlements) {
    if (e.year === year) entByEmp.set(e.employeeId, e);
  }

  /* Saldo iz view-a već sadrži used_days; ako nedostaje, fallback na ručni obračun. */
  const balByEmp = new Map();
  for (const b of kadrVacationState.balances) {
    if (b.year === year) balByEmp.set(b.employeeId, b);
  }

  const emps = kadrovskaState.employees.filter(e => {
    if (statusF === 'active' && !e.isActive) return false;
    if (q) {
      const hay = [e.fullName, e.firstName, e.lastName, e.department, e.team].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  return emps.map(emp => {
    const ent = entByEmp.get(emp.id);
    const bal = balByEmp.get(emp.id);
    const daysTotal = ent ? ent.daysTotal : 20;
    const daysCarried = ent ? ent.daysCarriedOver : 0;

    /* Fallback obračun iskorišćenog — iz absences (type='godisnji' te godine). */
    let daysUsed = bal ? bal.daysUsed : 0;
    if (!bal) {
      daysUsed = 0;
      for (const a of kadrAbsencesState.items) {
        if (a.type !== 'godisnji' || !a.dateFrom) continue;
        const y = Number(a.dateFrom.slice(0, 4));
        if (y !== year) continue;
        const days = a.daysCount != null
          ? Number(a.daysCount)
          : (a.dateFrom && a.dateTo
              ? (new Date(a.dateTo) - new Date(a.dateFrom)) / (24 * 3600 * 1000) + 1
              : 0);
        if (a.employeeId === emp.id) daysUsed += days;
      }
    }

    const remaining = daysTotal + daysCarried - daysUsed;
    return {
      emp,
      ent,
      year,
      daysTotal,
      daysCarried,
      daysUsed,
      daysRemaining: remaining,
    };
  });
}

function renderRows() {
  if (!panelRoot) return;
  const rows = computeRows();
  const tbody = panelRoot.querySelector('#vacTbody');
  const empty = panelRoot.querySelector('#vacEmpty');
  const countEl = panelRoot.querySelector('#vacCount');

  const badge = document.getElementById('kadrTabCountVacation');
  if (badge) badge.textContent = String(rows.length);
  if (countEl) countEl.textContent = `${rows.length} ${rows.length === 1 ? 'zaposleni' : 'zaposlenih'}`;

  const totalTotal = rows.reduce((s, r) => s + r.daysTotal + r.daysCarried, 0);
  const totalUsed = rows.reduce((s, r) => s + r.daysUsed, 0);
  const totalRemaining = rows.reduce((s, r) => s + r.daysRemaining, 0);
  const overLimit = rows.filter(r => r.daysRemaining < 0).length;
  renderSummaryChips('vacSummary', [
    { label: 'Ukupno dana', value: totalTotal, tone: 'accent' },
    { label: 'Iskorišćeno', value: totalUsed, tone: 'warn' },
    { label: 'Preostalo', value: totalRemaining, tone: totalRemaining > 0 ? 'ok' : 'muted' },
    { label: 'Prekoračilo', value: overLimit, tone: overLimit > 0 ? 'warn' : 'muted' },
  ]);

  if (!rows.length) {
    tbody.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  const edit = canEditKadrovska();
  tbody.innerHTML = rows.map(r => {
    const remCls = r.daysRemaining < 0 ? 'warn' : (r.daysRemaining < 3 ? 'accent' : 'ok');
    const entId = r.ent?.id || '';
    return `<tr data-emp-id="${escHtml(r.emp.id)}" data-ent-id="${escHtml(entId)}">
      <td><div class="emp-name">${escHtml(r.emp.fullName || '—')}</div></td>
      <td class="col-hide-sm">${escHtml(r.emp.department || '—')}</td>
      <td>
        <input type="number" class="vac-inp vac-total" min="0" max="365" step="1" value="${r.daysTotal}" ${edit ? '' : 'disabled'}>
      </td>
      <td>
        <input type="number" class="vac-inp vac-carry" min="0" max="365" step="1" value="${r.daysCarried}" ${edit ? '' : 'disabled'}>
      </td>
      <td><span style="font-family:var(--mono);font-weight:600;">${r.daysUsed}</span></td>
      <td><span class="kadr-type-badge t-${remCls}" style="font-family:var(--mono);font-weight:700;">${r.daysRemaining}</span></td>
      <td class="col-actions">
        <button class="btn-row-act" data-act="resenje" data-emp-id="${escHtml(r.emp.id)}">📄 Rešenje</button>
      </td>
    </tr>`;
  }).join('');

  /* Wire inline saves — debounce 500ms per row. */
  tbody.querySelectorAll('tr').forEach(tr => {
    const empId = tr.dataset.empId;
    const totalEl = tr.querySelector('.vac-total');
    const carryEl = tr.querySelector('.vac-carry');
    const year = Number(panelRoot.querySelector('#vacYear').value);
    let to;
    const save = () => {
      clearTimeout(to);
      to = setTimeout(() => persistEntitlement(empId, year, {
        daysTotal: parseInt(totalEl.value, 10) || 0,
        daysCarriedOver: parseInt(carryEl.value, 10) || 0,
      }, tr), 500);
    };
    totalEl?.addEventListener('change', save);
    carryEl?.addEventListener('change', save);
  });

  tbody.querySelectorAll('button[data-act="resenje"]').forEach(b => {
    b.addEventListener('click', () => openResenjePrint(b.dataset.empId));
  });
}

async function persistEntitlement(employeeId, year, patch, tr) {
  if (!canEditKadrovska()) return;
  const entId = tr?.dataset.entId || null;
  const payload = {
    id: entId || undefined,
    employeeId,
    year,
    daysTotal: patch.daysTotal,
    daysCarriedOver: patch.daysCarriedOver,
  };
  const res = await saveEntitlementToDb(payload);
  if (!res || !res.length) {
    showToast('⚠ Čuvanje nije uspelo');
    return;
  }
  const saved = mapDbEntitlement(res[0]);
  /* Update state.entitlements */
  const list = kadrVacationState.entitlements.filter(e => !(e.employeeId === employeeId && e.year === year));
  list.push(saved);
  kadrVacationState.entitlements = list;

  /* Osveži saldo iz view-a — najjeftinije je reload za tekuću godinu. */
  const bal = await loadBalancesFromDb(year);
  if (bal) kadrVacationState.balances = bal;

  if (tr) tr.dataset.entId = saved.id;
  renderRows();
  showToast('✅ Sačuvano');
}

/* ── REŠENJE O GO — print HTML ──────────────────────────────────── */

function openResenjePrint(employeeId) {
  const emp = kadrovskaState.employees.find(e => e.id === employeeId);
  if (!emp) { showToast('⚠ Zaposleni nije pronađen'); return; }

  const year = Number(panelRoot.querySelector('#vacYear').value);
  /* Pronađi najnoviji absences zapis tipa 'godisnji' te godine za tog zaposlenog —
     iz njega uzmi datume + broj dana. Ako ih ima više, prikaži najnoviji.
     Alternativno: ponudi dialog za ručni unos. */
  const abs = kadrAbsencesState.items
    .filter(a => a.type === 'godisnji' && a.employeeId === employeeId && a.dateFrom?.startsWith(String(year)))
    .sort((a, b) => String(b.dateFrom).localeCompare(String(a.dateFrom)))[0];

  let dateFrom = abs?.dateFrom || '';
  let dateTo = abs?.dateTo || '';
  let days = abs?.daysCount || 0;

  if (!abs) {
    const inFrom = prompt(`Unesi datum početka GO (YYYY-MM-DD) za ${emp.fullName}:`, '');
    if (!inFrom) return;
    const inTo = prompt('Unesi datum kraja GO (YYYY-MM-DD):', '');
    if (!inTo) return;
    dateFrom = inFrom; dateTo = inTo;
    days = Math.round((new Date(inTo) - new Date(inFrom)) / (24 * 3600 * 1000)) + 1;
  }

  const nowDay = new Date();
  const protocol = `GO-${year}-${String(emp.id).slice(0, 8).toUpperCase()}`;
  const fromStr = dateFrom ? formatDate(dateFrom) : '';
  const toStr = dateTo ? formatDate(dateTo) : '';
  const today = formatDate(nowDay.toISOString().slice(0, 10));

  const html = `<!DOCTYPE html>
<html lang="sr">
<head>
<meta charset="utf-8">
<title>Rešenje o godišnjem odmoru — ${escHtml(emp.fullName || '')}</title>
<style>
  @page { size: A4; margin: 2.2cm 2cm; }
  body { font-family: 'Times New Roman', Georgia, serif; color:#111; font-size: 12pt; line-height: 1.55; }
  .doc-head { text-align: right; margin-bottom: 28px; font-size: 11pt; color:#333; }
  .doc-head .company { font-weight: 700; font-size: 13pt; color:#000; }
  h1 { text-align:center; font-size: 15pt; margin: 8px 0 6px; text-transform: uppercase; letter-spacing: 0.5px; }
  h2 { text-align:center; font-size: 12pt; font-weight: 400; margin: 0 0 24px; color:#333; }
  p { margin: 10px 0; text-align: justify; }
  .meta { font-size: 11pt; color:#333; margin-bottom: 18px; }
  .meta-row { display:flex; justify-content:space-between; }
  table.pts { margin: 14px 0 0 14px; }
  table.pts td { padding: 3px 8px 3px 0; vertical-align: top; }
  .signs { margin-top: 48px; display:flex; justify-content: space-between; }
  .sign-box { width: 45%; text-align:center; }
  .sign-line { border-top:1px solid #333; padding-top:4px; font-size:10pt; color:#555; margin-top:40px; }
  .print-actions { margin: 20px 0; text-align:center; }
  .print-actions button { padding: 8px 20px; font-size: 12pt; cursor:pointer; }
  @media print { .print-actions { display:none; } }
</style>
</head>
<body>
  <div class="print-actions">
    <button onclick="window.print()">🖨 Štampaj</button>
    <button onclick="window.close()">Zatvori</button>
  </div>
  <div class="doc-head">
    <div class="company">SERVOTEH d.o.o.</div>
    <div>Dobanovci · Kruševac</div>
    <div>Broj: <strong>${escHtml(protocol)}</strong></div>
    <div>Datum: ${escHtml(today)}</div>
  </div>
  <h1>Rešenje</h1>
  <h2>o korišćenju godišnjeg odmora za ${escHtml(String(year))}. godinu</h2>

  <div class="meta">
    <div class="meta-row"><span>Zaposleni:</span><strong>${escHtml(emp.fullName || '')}</strong></div>
    ${emp.position ? `<div class="meta-row"><span>Radno mesto:</span><span>${escHtml(emp.position)}</span></div>` : ''}
    ${emp.department ? `<div class="meta-row"><span>Odeljenje:</span><span>${escHtml(emp.department)}</span></div>` : ''}
    ${emp.personalId ? `<div class="meta-row"><span>JMBG:</span><span>${escHtml(emp.personalId)}</span></div>` : ''}
  </div>

  <p>
    Na osnovu člana 68–73. Zakona o radu („Sl. glasnik RS“, br. 24/2005 i dr.)
    i odluke poslodavca, imenovanom se odobrava korišćenje godišnjeg odmora za
    <strong>${escHtml(String(year))}. godinu</strong> u trajanju od
    <strong>${escHtml(String(days || ''))} ${days === 1 ? 'dan' : 'dana'}</strong>,
    ${fromStr && toStr
      ? `u periodu od <strong>${escHtml(fromStr)}</strong> do <strong>${escHtml(toStr)}</strong>.`
      : `u periodu koji će biti naknadno utvrđen.`}
  </p>

  <p>
    Zaposleni je dužan da po isteku godišnjeg odmora, najkasnije prvog narednog
    radnog dana, pristupi izvršenju svojih redovnih radnih obaveza.
  </p>

  <p>
    Ovo rešenje stupa na snagu danom donošenja, a uručuje se zaposlenom, HR
    službi i finansijskoj službi.
  </p>

  <table class="pts">
    <tr><td>•</td><td>Osnov: član 68. Zakona o radu</td></tr>
    <tr><td>•</td><td>Ukupan broj dana GO za ${escHtml(String(year))}: prema evidenciji</td></tr>
  </table>

  <div class="signs">
    <div class="sign-box">
      <div class="sign-line">Zaposleni</div>
      <div>${escHtml(emp.fullName || '')}</div>
    </div>
    <div class="sign-box">
      <div class="sign-line">Direktor / ovlašćeno lice</div>
      <div>&nbsp;</div>
    </div>
  </div>
</body>
</html>`;

  const w = window.open('', '_blank', 'width=900,height=1200,scrollbars=1');
  if (!w) { showToast('⚠ Pop-up blocker je sprečio prozor'); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

/* ── Excel export ───────────────────────────────────────────────── */

async function exportToExcel() {
  const rows = computeRows();
  if (!rows.length) { showToast('Nema podataka za izvoz'); return; }
  const XLSX = await loadXlsx();
  const year = Number(panelRoot.querySelector('#vacYear').value);
  const data = [
    ['Zaposleni', 'Odeljenje', 'Dana pravo', 'Preneto', 'Iskorišćeno', 'Preostalo'],
    ...rows.map(r => [
      r.emp.fullName || '',
      r.emp.department || '',
      r.daysTotal,
      r.daysCarried,
      r.daysUsed,
      r.daysRemaining,
    ]),
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, `GO ${year}`);
  XLSX.writeFile(wb, `Godisnji_odmor_${year}.xlsx`);
}
