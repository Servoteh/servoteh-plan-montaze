/**
 * Izveštaji tab — kalendar, unos van-planskih sati, obračun.
 */

import { escHtml } from '../../lib/dom.js';
import {
  filterWorkReportsByPeriod,
  sumHours,
  groupByEmployee,
} from './izvestajiObracun.js';
import { createPbWorkReport, deletePbWorkReport } from '../../services/pb.js';
import {
  pbErrorMessage,
  showPbToast,
  setPbIzvestajiSpeechRecog,
} from './shared.js';

function pad2(n) {
  return String(n).padStart(2, '0');
}

function ymd(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function monthMatrix(year, month0) {
  const first = new Date(year, month0, 1);
  const startPad = (first.getDay() + 6) % 7;
  const weeks = [];
  let cur = new Date(first);
  cur.setDate(1 - startPad);
  for (let w = 0; w < 6; w++) {
    const row = [];
    for (let d = 0; d < 7; d++) {
      row.push(new Date(cur));
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(row);
  }
  return { weeks };
}

function hoursForDay(reports, dayStr) {
  const rows = reports.filter(r => String(r.datum || '').slice(0, 10) === dayStr);
  const h = sumHours(rows);
  return { rows, h };
}

/**
 * @param {HTMLElement} root
 * @param {{
 *   getWorkReports: () => object[],
 *   engineers: object[],
 *   canEdit: boolean,
 *   defaultEmployeeId: string|null,
 *   actorEmail: string|null,
 *   onRefresh: () => Promise<void>|void,
 * }} ctx
 */
export function renderIzvestaji(root, ctx) {
  let viewYear = new Date().getFullYear();
  let viewMonth = new Date().getMonth();
  let selectedDay = ymd(new Date());
  let sliderTicks = 20;

  function engineerForActor() {
    const em = ctx.actorEmail?.toLowerCase()?.trim();
    if (!em) return null;
    const en = ctx.engineers.find(
      e => String(e.email || '').toLowerCase().trim() === em,
    );
    return en?.id ?? null;
  }

  function paint() {
    const reports = ctx.getWorkReports() || [];
    const engDefault = ctx.defaultEmployeeId || engineerForActor() || '';
    const { weeks } = monthMatrix(viewYear, viewMonth);
    const todayStr = ymd(new Date());

    const cells = weeks.map(row => `
      <tr>${row.map(cell => {
        const ds = ymd(cell);
        const inMonth = cell.getMonth() === viewMonth;
        const dow = cell.getDay();
        const isW = dow === 0 || dow === 6;
        const isToday = ds === todayStr;
        const sel = ds === selectedDay;
        const { h } = hoursForDay(reports, ds);
        let cls = 'pb-cal-cell';
        if (!inMonth) cls += ' pb-cal-cell--muted';
        if (isW) cls += ' pb-cal-cell--wknd';
        if (isToday) cls += ' pb-cal-cell--today';
        if (sel) cls += ' pb-cal-cell--sel';
        const dot = h > 0 ? `<span class="pb-cal-dot">• ${escHtml(String(h))}h</span>` : '';
        return `<td><button type="button" class="${cls}" data-day="${escHtml(ds)}">
          <span class="pb-cal-num">${cell.getDate()}</span>${dot}
        </button></td>`;
      }).join('')}</tr>`).join('');

    const monthLabel = new Date(viewYear, viewMonth, 1).toLocaleString('sr-Latn', {
      month: 'long',
      year: 'numeric',
    });

    const dayReports = reports.filter(
      r => String(r.datum || '').slice(0, 10) === selectedDay,
    );

    const defaultFrom = `${viewYear}-${pad2(viewMonth + 1)}-01`;
    const defaultTo = ymd(new Date());

    root.innerHTML = `
      <div class="pb-izv-grid">
        <section class="pb-izv-cal" aria-label="Kalendar">
          <div class="pb-izv-cal-nav">
            <button type="button" class="btn btn-sm" id="pbIzvPrev">←</button>
            <strong>${escHtml(monthLabel)}</strong>
            <button type="button" class="btn btn-sm" id="pbIzvNext">→</button>
          </div>
          <table class="pb-cal-table">
            <thead><tr>
              <th>Pon</th><th>Uto</th><th>Sre</th><th>Čet</th><th>Pet</th><th>Sub</th><th>Ned</th>
            </tr></thead>
            <tbody>${cells}</tbody>
          </table>
        </section>

        <section class="pb-izv-form-wrap">
          <h3 class="pb-section-title">Izveštaj za ${escHtml(selectedDay.split('-').reverse().join('.'))}</h3>
          <div class="pb-izv-form">
            <label class="pb-field"><span>Inženjer *</span>
              <select id="pbIzvEng" ${ctx.canEdit ? '' : 'disabled'}>
                <option value="">— izaberi —</option>
                ${(ctx.engineers || []).map(e => `
                  <option value="${escHtml(e.id)}" ${engDefault === e.id ? 'selected' : ''}>${escHtml(e.full_name)}</option>
                `).join('')}
              </select>
            </label>
            <label class="pb-field"><span>Sati (0.5–12)</span>
              <div class="pb-norm-row">
            <input type="range" id="pbIzvSatR" min="1" max="24" step="1" value="${sliderTicks}" ${ctx.canEdit ? '' : 'disabled'} />
            <input type="number" id="pbIzvSatN" min="0.5" max="12" step="0.5" value="${(sliderTicks / 2).toFixed(1)}" ${ctx.canEdit ? '' : 'disabled'} />
              </div>
            </label>
            <label class="pb-field"><span>Opis rada</span>
              <textarea id="pbIzvOpis" class="pb-textarea-lg" rows="4" placeholder="Kratki opis šta je urađeno tog dana..."
                ${ctx.canEdit ? '' : 'disabled'}></textarea>
            </label>
            ${ctx.canEdit ? `<div class="pb-izv-mic-row">
              <button type="button" class="btn btn-sm" id="pbIzvMic" title="">🎙 Glasovni unos</button>
            </div>` : ''}
            ${ctx.canEdit ? `<div class="pb-modal-actions">
              <button type="button" class="btn btn-primary" id="pbIzvSave">Sačuvaj</button>
              <button type="button" class="btn" id="pbIzvCancel">Otkaži</button>
            </div>` : ''}
          </div>

          <div class="pb-izv-day-list">
            <h4 class="pb-section-title">Unosi za dan</h4>
            ${dayReports.length ? dayReports.map(r => `
              <div class="pb-izv-row" data-wrid="${escHtml(r.id)}">
                <span class="pb-avatar">${escHtml((r.engineer_name || '?').slice(0, 1))}</span>
                <div class="pb-izv-row-main">
                  <strong>${escHtml(r.engineer_name || '—')}</strong>
                  <span class="pb-muted">${Number(r.sati) || 0}h</span>
                  <p>${escHtml(r.opis || '')}</p>
                </div>
                ${ctx.canEdit ? `<button type="button" class="btn btn-sm pb-izv-del" data-id="${escHtml(r.id)}">✕</button>` : ''}
              </div>`).join('')
              : '<p class="pb-muted">Nema unetih izveštaja za ovaj dan.</p>'}
          </div>
        </section>

        <section class="pb-izv-sum" aria-label="Obračun po periodu">
          <h3 class="pb-section-title">Obračun po periodu</h3>
          <div class="pb-izv-sum-filters">
            <label>Od <input type="date" id="pbIzvFrom" value="${escHtml(defaultFrom)}" /></label>
            <label>Do <input type="date" id="pbIzvTo" value="${escHtml(defaultTo)}" /></label>
            <label>Inženjer
              <select id="pbIzvSumEng">
                <option value="all">Svi inženjeri</option>
                ${(ctx.engineers || []).map(e => `<option value="${escHtml(e.id)}">${escHtml(e.full_name)}</option>`).join('')}
              </select>
            </label>
            <button type="button" class="btn btn-primary btn-sm" id="pbIzvCalc">Izračunaj</button>
          </div>
          <div id="pbIzvSumOut" class="pb-izv-sum-out"></div>
        </section>
      </div>`;

    const satR = root.querySelector('#pbIzvSatR');
    const satN = root.querySelector('#pbIzvSatN');
    satR?.addEventListener('input', () => {
      sliderTicks = Number(satR.value) || 20;
      if (satN) satN.value = (sliderTicks / 2).toFixed(1);
    });
    satN?.addEventListener('input', () => {
      const v = Math.round((Number(satN.value) || 1) * 2);
      sliderTicks = Math.min(24, Math.max(1, v));
      if (satR) satR.value = String(sliderTicks);
    });

    root.querySelector('#pbIzvPrev')?.addEventListener('click', () => {
      viewMonth -= 1;
      if (viewMonth < 0) {
        viewMonth = 11;
        viewYear -= 1;
      }
      paint();
    });
    root.querySelector('#pbIzvNext')?.addEventListener('click', () => {
      viewMonth += 1;
      if (viewMonth > 11) {
        viewMonth = 0;
        viewYear += 1;
      }
      paint();
    });

    root.querySelectorAll('[data-day]').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedDay = btn.getAttribute('data-day') || selectedDay;
        paint();
      });
    });

    root.querySelector('#pbIzvSave')?.addEventListener('click', async () => {
      const emp = root.querySelector('#pbIzvEng')?.value;
      const sat = Number(root.querySelector('#pbIzvSatN')?.value) || 1;
      const opis = root.querySelector('#pbIzvOpis')?.value?.trim() ?? '';
      if (!emp) {
        showPbToast('Izaberi inženjera', 'warning');
        return;
      }
      try {
        await createPbWorkReport({
          employee_id: emp,
          datum: selectedDay,
          sati: sat,
          opis,
        });
        showPbToast('Sačuvano', 'success');
        root.querySelector('#pbIzvOpis').value = '';
        await ctx.onRefresh?.();
        paint();
      } catch (err) {
        showPbToast(pbErrorMessage(err), 'error');
      }
    });

    root.querySelector('#pbIzvCancel')?.addEventListener('click', () => {
      root.querySelector('#pbIzvOpis').value = '';
    });

    root.querySelectorAll('.pb-izv-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        if (!id || !confirm('Obrisati izveštaj?')) return;
        try {
          await deletePbWorkReport(id);
          showPbToast('Obrisano', 'success');
          await ctx.onRefresh?.();
          paint();
        } catch (err) {
          showPbToast(pbErrorMessage(err), 'error');
        }
      });
    });

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const micBtn = root.querySelector('#pbIzvMic');
    if (micBtn) {
      if (!SR) {
        micBtn.style.display = 'none';
        micBtn.disabled = true;
        micBtn.title = 'Glasovni unos nije podržan u ovom pregledaču';
      } else {
        micBtn.title = 'Klik za start/stop diktata';
      }
    }

    let recog = null;
    root.querySelector('#pbIzvMic')?.addEventListener('click', () => {
      const SR2 = window.SpeechRecognition || window.webkitSpeechRecognition;
      const ta = root.querySelector('#pbIzvOpis');
      if (!SR2 || !ta) {
        showPbToast('Glasovni unos nije podržan u ovom pregledaču', 'warning');
        return;
      }
      if (recog) {
        try { recog.stop(); } catch { /* */ }
        recog = null;
        setPbIzvestajiSpeechRecog(null);
        showPbToast('Mikrofon zaustavljen', 'info');
        return;
      }
      recog = new SR2();
      setPbIzvestajiSpeechRecog(recog);
      recog.lang = 'sr-RS';
      recog.continuous = false;
      recog.interimResults = false;
      recog.onresult = ev => {
        const t = ev.results?.[0]?.[0]?.transcript;
        if (t) ta.value = (ta.value ? ta.value + ' ' : '') + t;
      };
      recog.onerror = () => showPbToast('Greška mikrofona', 'error');
      recog.start();
      showPbToast('Slušam… (klik ponovo za stop)', 'info');
    });

    function runSum() {
      const df = root.querySelector('#pbIzvFrom')?.value || '';
      const dt = root.querySelector('#pbIzvTo')?.value || '';
      const eng = root.querySelector('#pbIzvSumEng')?.value || 'all';
      const filt = filterWorkReportsByPeriod(ctx.getWorkReports() || [], df, dt, eng === 'all' ? null : eng);
      const totalH = sumHours(filt);
      const grp = groupByEmployee(filt);
      const sorted = Object.entries(grp).sort((a, b) => b[1].hours - a[1].hours);
      const rows = sorted.map(([, v]) => `
        <div class="pb-izv-sum-row">
          <span class="pb-avatar">${escHtml(v.name.slice(0, 1))}</span>
          <span>${escHtml(v.name)}</span>
          <span>${v.count} izv.</span>
          <strong>${escHtml(String(v.hours))}h</strong>
        </div>`).join('');
      root.querySelector('#pbIzvSumOut').innerHTML = `
        <p>Ukupno izveštaja: <strong>${filt.length}</strong> · Ukupno sati: <strong>${totalH}h</strong></p>
        <div class="pb-izv-sum-rows">${rows || '<p class="pb-muted">Nema podataka.</p>'}</div>`;
    }

    root.querySelector('#pbIzvCalc')?.addEventListener('click', runSum);
    runSum();
  }

  paint();
}
