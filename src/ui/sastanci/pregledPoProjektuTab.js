/**
 * Pregled tema po projektu — admin može da postavlja master prioritet
 * (admin_rang) putem drag-drop ili direktnog input-a.
 *
 * Layout:
 *   - Levo: lista projekata (klikabilna, jedan aktivan)
 *   - Desno: lista tema selektovanog projekta (drag-drop + rang input)
 *
 * Read-only za sve osim admina.
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { formatDate } from '../../lib/date.js';
import {
  loadPmTeme, reorderProjektTeme, setAdminRang, setZaRazmatranje, setHitno,
  TEMA_STATUSI, TEMA_STATUS_BOJE,
} from '../../services/pmTeme.js';
import { loadProjektiLite } from '../../services/projekti.js';
import { canPrioritizeTeme } from '../../state/auth.js';

let abortFlag = false;
let cachedProjekti = [];
let cachedTeme = [];
let activeProjekatId = null;

export async function renderPregledPoProjektuTab(host) {
  abortFlag = false;
  const isAdmin = canPrioritizeTeme();

  host.innerHTML = `
    <div class="sast-section">
      <div class="sast-pregled-header">
        <h3>Pregled tema po projektu</h3>
        <p class="sast-pregled-sub">
          ${isAdmin
            ? 'Prevuci redove ili upiši rang da postaviš redosled razmatranja po projektu. Tema sa rangom 1 ide prva.'
            : 'Pregled rasporeda tema po projektu (read-only).'}
        </p>
      </div>

      <div class="sast-pregled-grid">
        <aside class="sast-pregled-projekti">
          <h4>Projekti</h4>
          <div id="projektiList" class="sast-projekti-list">
            <div class="sast-loading">Učitavam projekte…</div>
          </div>
        </aside>
        <section class="sast-pregled-teme">
          <div id="temeList">
            <div class="sast-empty">Izaberi projekat sa leve strane.</div>
          </div>
        </section>
      </div>
    </div>
  `;

  cachedProjekti = await loadProjektiLite();
  if (abortFlag) return;
  renderProjektiList(host, { isAdmin });

  /* Auto-select prvi projekat ako postoji. */
  if (cachedProjekti.length && !activeProjekatId) {
    activeProjekatId = cachedProjekti[0].id;
  }
  if (activeProjekatId) {
    await loadAndRenderTeme(host, { isAdmin });
  }
}

export function teardownPregledPoProjektuTab() {
  abortFlag = true;
}

function renderProjektiList(host, { isAdmin }) {
  const list = host.querySelector('#projektiList');
  if (!cachedProjekti.length) {
    list.innerHTML = '<div class="sast-empty">Nema projekata u bazi.</div>';
    return;
  }
  list.innerHTML = cachedProjekti.map(p => `
    <button type="button" class="sast-projekat-item${p.id === activeProjekatId ? ' is-active' : ''}"
            data-id="${p.id}">
      <div class="sast-projekat-naslov">${escHtml(p.label)}</div>
      ${p.client ? `<div class="sast-projekat-sub">${escHtml(p.client)}</div>` : ''}
    </button>
  `).join('');

  list.querySelectorAll('.sast-projekat-item').forEach(btn => {
    btn.addEventListener('click', async () => {
      activeProjekatId = btn.dataset.id;
      list.querySelectorAll('.sast-projekat-item').forEach(b => b.classList.toggle('is-active', b === btn));
      await loadAndRenderTeme(host, { isAdmin });
    });
  });
}

async function loadAndRenderTeme(host, { isAdmin }) {
  const target = host.querySelector('#temeList');
  if (!activeProjekatId) {
    target.innerHTML = '<div class="sast-empty">Izaberi projekat sa leve strane.</div>';
    return;
  }
  target.innerHTML = '<div class="sast-loading">Učitavam teme za projekat…</div>';
  cachedTeme = await loadPmTeme({ projekatId: activeProjekatId, limit: 500 });
  if (abortFlag) return;
  renderTeme(host, { isAdmin });
}

function renderTeme(host, { isAdmin }) {
  const target = host.querySelector('#temeList');
  if (!cachedTeme.length) {
    target.innerHTML = '<div class="sast-empty">Ovaj projekat nema povezanih tema.</div>';
    return;
  }

  const projekat = cachedProjekti.find(p => p.id === activeProjekatId);
  target.innerHTML = `
    <div class="sast-pregled-toolbar">
      <h4>${escHtml(projekat?.label || '')}</h4>
      <div class="sast-pregled-meta">
        <span>${cachedTeme.length} tema</span>
        ${isAdmin ? '<button class="btn" id="renumberBtn" title="Renumeriši rang 1..N po trenutnom redosledu">↻ Renumeriši rang</button>' : ''}
      </div>
    </div>

    <table class="sast-table sast-pregled-table">
      <thead>
        <tr>
          <th class="th-rang">Rang</th>
          <th>Status</th>
          <th>Naslov</th>
          <th>Predložio</th>
          <th>Flag-ovi</th>
          <th>Datum</th>
        </tr>
      </thead>
      <tbody id="temeTbody">
        ${cachedTeme.map(t => renderTemaRow(t, { isAdmin })).join('')}
      </tbody>
    </table>
  `;

  if (isAdmin) {
    enableDragDrop(host);
    target.querySelectorAll('.rang-input').forEach(inp => {
      inp.addEventListener('change', async () => {
        const id = inp.dataset.id;
        const val = inp.value === '' ? null : Number(inp.value);
        const r = await setAdminRang(id, val);
        if (r) {
          showToast('# Rang ažuriran');
          await loadAndRenderTeme(host, { isAdmin });
        } else {
          showToast('⚠ Greška pri snimanju ranga');
        }
      });
    });
    target.querySelectorAll('[data-flag]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const flag = btn.dataset.flag;
        const tema = cachedTeme.find(t => t.id === id);
        if (!tema) return;
        if (flag === 'hitno') {
          const r = await setHitno(id, !tema.hitno);
          if (r) await loadAndRenderTeme(host, { isAdmin });
        } else if (flag === 'razmatra') {
          const r = await setZaRazmatranje(id, !tema.zaRazmatranje);
          if (r) await loadAndRenderTeme(host, { isAdmin });
        }
      });
    });

    host.querySelector('#renumberBtn')?.addEventListener('click', async () => {
      if (!confirm('Renumeriši sve teme u ovom projektu od 1 do N po trenutnom redosledu?')) return;
      const items = cachedTeme.map((t, idx) => ({ id: t.id, rang: idx + 1 }));
      const ok = await reorderProjektTeme(items);
      if (ok) {
        showToast('↻ Rang renumerisan 1..N');
        await loadAndRenderTeme(host, { isAdmin });
      } else {
        showToast('⚠ Greška pri renumerisanju');
      }
    });
  }
}

function renderTemaRow(t, { isAdmin }) {
  const color = TEMA_STATUS_BOJE[t.status] || '#666';
  const rowCls = [
    t.hitno ? 'is-hitno' : '',
    t.zaRazmatranje ? 'is-razmatra' : '',
  ].filter(Boolean).join(' ');

  const flags = [];
  if (isAdmin) {
    flags.push(`<button class="btn-icon ${t.hitno ? 'btn-danger active' : 'btn-ghost'}" data-flag="hitno" data-id="${t.id}" title="${t.hitno ? 'Skini Hitno' : 'Označi kao Hitno'}">🔥</button>`);
    flags.push(`<button class="btn-icon ${t.zaRazmatranje ? 'btn-warn active' : 'btn-ghost'}" data-flag="razmatra" data-id="${t.id}" title="${t.zaRazmatranje ? 'Skini "za razmatranje"' : 'Označi za razmatranje'}">🎯</button>`);
  } else {
    if (t.hitno) flags.push('<span class="sast-flag flag-hitno">🔥</span>');
    if (t.zaRazmatranje) flags.push('<span class="sast-flag flag-razmatra">🎯</span>');
  }

  const rangCell = isAdmin
    ? `<input type="number" class="rang-input" data-id="${t.id}" value="${t.adminRang ?? ''}" min="1" max="999" placeholder="—">`
    : `<span class="rang-display">${t.adminRang ?? '—'}</span>`;

  const dragAttrs = isAdmin ? 'draggable="true"' : '';

  return `
    <tr class="${rowCls}" data-id="${t.id}" ${dragAttrs}>
      <td class="td-rang">
        ${isAdmin ? '<span class="drag-handle" title="Prevuci">⋮⋮</span>' : ''}
        ${rangCell}
      </td>
      <td><span class="sast-status-pill" style="background:${color}">${escHtml(TEMA_STATUSI[t.status] || t.status)}</span></td>
      <td>
        <div><strong>${escHtml(t.naslov)}</strong></div>
        ${t.opis ? `<div class="sast-row-sub">${escHtml(t.opis.slice(0, 150))}${t.opis.length > 150 ? '…' : ''}</div>` : ''}
      </td>
      <td>${escHtml(t.predlozioLabel || t.predlozioEmail)}</td>
      <td class="sast-td-flags">${flags.join(' ')}</td>
      <td>${escHtml(formatDate(t.predlozioAt))}</td>
    </tr>
  `;
}

/* ── Drag-drop reorder ── */

let draggedId = null;

function enableDragDrop(host) {
  const tbody = host.querySelector('#temeTbody');
  if (!tbody) return;

  tbody.querySelectorAll('tr[draggable=true]').forEach(tr => {
    tr.addEventListener('dragstart', (e) => {
      draggedId = tr.dataset.id;
      tr.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', draggedId); } catch (err) { /* ignore */ }
    });
    tr.addEventListener('dragend', () => {
      tr.classList.remove('dragging');
      draggedId = null;
      tbody.querySelectorAll('tr.drop-target').forEach(r => r.classList.remove('drop-target'));
    });
    tr.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      tbody.querySelectorAll('tr.drop-target').forEach(r => r.classList.remove('drop-target'));
      tr.classList.add('drop-target');
    });
    tr.addEventListener('drop', async (e) => {
      e.preventDefault();
      const dropTargetId = tr.dataset.id;
      tr.classList.remove('drop-target');
      if (!draggedId || draggedId === dropTargetId) return;

      const fromIdx = cachedTeme.findIndex(t => t.id === draggedId);
      const toIdx = cachedTeme.findIndex(t => t.id === dropTargetId);
      if (fromIdx < 0 || toIdx < 0) return;

      const [moved] = cachedTeme.splice(fromIdx, 1);
      cachedTeme.splice(toIdx, 0, moved);

      const items = cachedTeme.map((t, idx) => ({ id: t.id, rang: idx + 1 }));
      const ok = await reorderProjektTeme(items);
      if (ok) {
        showToast('↕ Redosled snimljen');
        await loadAndRenderTeme(host, { isAdmin: true });
      } else {
        showToast('⚠ Greška pri snimanju redosleda');
      }
    });
  });
}
