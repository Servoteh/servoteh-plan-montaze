import { escHtml } from '../../lib/dom.js';
import { statusBadgeHtml } from './statusBadge.js';
import { openOperacijaSidePanel } from './tab1OperacijaSidePanel.js';

export function tab1PozicijeHtml(state) {
  const positions = state.tab1Data?.positions || [];
  if (state.loading) return skeletonHtml('Učitavanje pozicija…');
  if (!positions.length) {
    return emptyHtml('Nema pozicija za izabrani RN', 'Kada backend vrati production.radni_nalog_pozicija podatke, ovde se prikazuje tree-grid.');
  }
  const tree = buildTree(positions);
  return `
    <section class="form-card" style="margin-bottom:14px">
      <div class="pp-toolbar" style="margin:0">
        <div class="pp-toolbar-spacer"></div>
        <button type="button" class="pp-refresh-btn" id="exportTab1Btn">Excel export</button>
      </div>
    </section>
    <section class="pp-table-wrap">
      <table class="pp-table">
        <thead>
          <tr>
            <th>Pozicija</th>
            <th>Naziv</th>
            <th>Crtež</th>
            <th class="pp-cell-num">Količina</th>
            <th>% progress</th>
          </tr>
        </thead>
        <tbody>
          ${tree.map(node => positionRowHtml(node, 0)).join('')}
        </tbody>
      </table>
    </section>
  `;
}

export function wireTab1Pozicije(root, state) {
  root.querySelectorAll('[data-op-id]').forEach(row => {
    row.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const pos = findPosition(state.tab1Data?.positions || [], row.dataset.posId);
      const op = (pos?.operations || []).find(o => String(o.tp_operacija_id) === row.dataset.opId);
      if (pos && op) openOperacijaSidePanel({ position: pos, operation: op });
    });
  });
}

function positionRowHtml(node, depth) {
  const p = node.item;
  const operations = p.operations || [];
  const children = node.children || [];
  const detailId = `pos-${String(p.id || '').replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const hasDetails = operations.length || children.length;
  const indent = Math.min(depth * 20, 60);
  return `
    <tr>
      <td colspan="5" style="padding:0">
        <details ${depth === 0 ? 'open' : ''} id="${escHtml(detailId)}">
          <summary style="display:grid;grid-template-columns:minmax(160px,1.2fr) minmax(220px,2fr) minmax(120px,.8fr) 100px 180px;gap:8px;align-items:center;padding:10px 8px;cursor:${hasDetails ? 'pointer' : 'default'}">
            <span style="padding-left:${indent}px;font-weight:700">${escHtml(p.sifra_pozicije || p.id || '—')}</span>
            <span>${escHtml(p.naziv || '—')}</span>
            <span class="pp-cell-muted">${escHtml(p.drawing_no || p.sifra_pozicije || '—')}</span>
            <span class="pp-cell-num">${escHtml(p.kolicina_plan ?? '—')}</span>
            ${progressHtml(p.progress_pct)}
          </summary>
          ${operations.length ? operationsHtml(operations, p.id) : ''}
          ${children.length ? children.map(ch => positionRowHtml(ch, depth + 1)).join('') : ''}
        </details>
      </td>
    </tr>
  `;
}

function operationsHtml(operations, positionId) {
  return `
    <div style="padding:0 12px 12px 34px">
      <table class="pp-table" style="background:var(--surface2)">
        <thead>
          <tr>
            <th>Operacija</th>
            <th>Naziv</th>
            <th>Work center</th>
            <th class="pp-cell-num">Planirano</th>
            <th class="pp-cell-num">Prijavljeno</th>
            <th>Status</th>
            <th>Poslednja prijava</th>
          </tr>
        </thead>
        <tbody>
          ${operations.map(op => `
            <tr data-pos-id="${escHtml(positionId || '')}" data-op-id="${escHtml(op.tp_operacija_id || '')}" style="cursor:pointer" title="Otvori istoriju prijava">
              <td class="pp-cell-strong">${escHtml(op.operacija_kod || '—')}</td>
              <td>${escHtml(op.naziv || '—')}</td>
              <td>${escHtml(op.work_center || '—')}</td>
              <td class="pp-cell-num">${escHtml(op.planirano_komada ?? '—')}</td>
              <td class="pp-cell-num">${escHtml(op.prijavljeno_komada ?? 0)}</td>
              <td>${statusBadgeHtml(op.status, { button: false })}</td>
              <td>${escHtml(formatDateTime(op.poslednja_prijava_at))}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function progressHtml(pctRaw) {
  const pct = Math.max(0, Math.min(100, Number(pctRaw || 0)));
  return `
    <div title="${pct}%">
      <div style="height:8px;background:var(--surface3);border-radius:999px;overflow:hidden;border:1px solid var(--border2)">
        <div style="height:100%;width:${pct}%;background:var(--blue-bar,#4f9bff)"></div>
      </div>
      <div class="form-hint" style="margin-top:2px">${pct}%</div>
    </div>
  `;
}

function buildTree(positions) {
  const nodes = new Map();
  positions.forEach(p => nodes.set(p.id, { item: p, children: [] }));
  const roots = [];
  nodes.forEach(node => {
    const parentId = node.item.parent_id;
    if (parentId && nodes.has(parentId)) nodes.get(parentId).children.push(node);
    else roots.push(node);
  });
  return roots;
}

function findPosition(positions, id) {
  return positions.find(p => String(p.id) === String(id));
}

function skeletonHtml(text) {
  return `<div class="pp-state"><div class="pp-state-icon">...</div><div class="pp-state-title">${escHtml(text)}</div></div>`;
}

function emptyHtml(title, desc) {
  return `<div class="pp-state"><div class="pp-state-icon">📭</div><div class="pp-state-title">${escHtml(title)}</div><div class="pp-state-desc">${escHtml(desc)}</div></div>`;
}

function formatDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString('sr-RS');
}
