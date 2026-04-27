/**
 * Ekran 2 — stablo podsklopova (flat RPC → tree render).
 */

import { escHtml } from '../../lib/dom.js';
import { ensureRadniNalogFromBigtehn } from '../../services/pracenjeProizvodnje.js';
import {
  clearSelectedPredmet,
  loadPracenje,
  selectPredmet,
  startRealtime,
} from '../../state/pracenjeProizvodnjeState.js';
import { predmetTabsStripHtml, wirePredmetTabs } from './tabelaPracenjaTab.js';

function treeExpandKey(itemId) {
  return `pracenjeTreeExpand:v1:${itemId}`;
}

function loadExpandedSet(itemId) {
  try {
    const raw = localStorage.getItem(treeExpandKey(itemId));
    const a = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(a) ? a.map(String) : []);
  } catch {
    return new Set();
  }
}

function saveExpandedSet(itemId, set) {
  try {
    localStorage.setItem(treeExpandKey(itemId), JSON.stringify([...set]));
  } catch {
    /* ignore */
  }
}

function rowKey(r) {
  const p = r.path_idrn;
  if (Array.isArray(p) && p.length) return p.map(String).join(':');
  return `${r.root_rn_id}:${r.parent_rn_id ?? 'r'}:${r.rn_id}`;
}

function childrenOf(flat, rootRnId, parentRnId) {
  return flat
    .filter((r) => {
      if (Number(r.root_rn_id) !== Number(rootRnId)) return false;
      if (parentRnId == null) return r.parent_rn_id == null;
      return Number(r.parent_rn_id) === Number(parentRnId);
    })
    .sort((a, b) => String(a.ident_broj || '').localeCompare(String(b.ident_broj || ''), undefined, { numeric: true }));
}

function rootsOf(flat) {
  const rs = flat.filter((r) => r.parent_rn_id == null && Number(r.nivo ?? 0) === 0);
  const seen = new Set();
  const out = [];
  for (const r of rs) {
    const k = `${r.root_rn_id}:${r.rn_id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out.sort((a, b) => String(a.ident_broj || '').localeCompare(String(b.ident_broj || ''), undefined, { numeric: true }));
}

function hasChildren(flat, r) {
  return childrenOf(flat, r.root_rn_id, r.rn_id).length > 0;
}

function renderRowsHtml(flat, expanded, depth, parentRow) {
  const rootRnId = parentRow.root_rn_id;
  const parentRnId = parentRow.rn_id;
  const kids = childrenOf(flat, rootRnId, parentRnId);
  if (!kids.length) return '';
  return kids.map((ch) => {
    const k = rowKey(ch);
    const open = expanded.has(k);
    const hc = hasChildren(flat, ch);
    const indent = 18 + depth * 18;
    const label = `${escHtml(String(ch.ident_broj || ''))} — ${escHtml(String(ch.naziv_dela || ''))}`;
    const mes = ch.is_mes_aktivan
      ? '<span class="pp-counter" title="MES aktivan">MES</span>'
      : '';
    const st = ch.status_rn === true || ch.status_rn === false
      ? `<span class="pp-counter" title="status_rn">${ch.status_rn ? 'akt.' : 'neakt.'}</span>`
      : '';
    const toggle = hc
      ? `<button type="button" class="pp-tree-toggle" data-tree-key="${escHtml(k)}" aria-expanded="${open ? 'true' : 'false'}" title="${open ? 'Skupi' : 'Proširi'}">${open ? '▼' : '▶'}</button>`
      : '<span class="pp-tree-toggle-spacer" aria-hidden="true"></span>';
    const nested = hc && open ? renderRowsHtml(flat, expanded, depth + 1, ch) : '';
    return `
      <tr class="pp-tree-row" data-tree-parent="${escHtml(rowKey(parentRow))}" data-tree-key="${escHtml(k)}">
        <td class="pp-tree-cell" style="padding-left:${indent}px">
          ${toggle}
          <span class="pp-tree-label pp-pickable-rn-tree" data-bigtehn-id="${escHtml(String(ch.legacy_idrn ?? ch.rn_id))}" style="cursor:pointer">${label}</span>
          ${mes}${st}
        </td>
      </tr>
      ${nested}`;
  }).join('');
}

export function podsklopoviTreeHtml(state) {
  const ap = state.aktivniPredmetiState || {};
  const hid = ap.headerPredmet || {};
  const naz = escHtml(String(hid.naziv_predmeta || 'Predmet'));
  const bp = escHtml(String(hid.broj_predmeta || ''));
  const kom = escHtml(String(hid.customer_name || ''));

  const tabs = predmetTabsStripHtml(ap.activePredmetTab || 'stablo');

  if (ap.podsklopoviLoading) {
    return `
      <section class="form-card" style="margin-bottom:14px">
        <div class="pp-toolbar" style="margin:0 0 12px">
          <button type="button" class="pp-refresh-btn" id="ppPredmetBackBtn">← Nazad na listu predmeta</button>
        </div>
        ${tabs}
        <h2 class="form-section-title" style="margin:0 0 8px">${naz}</h2>
        <p class="form-hint">${bp}${kom ? ` · ${kom}` : ''}</p>
        <p class="form-hint">Učitavanje stabla…</p>
      </section>
    `;
  }
  if (ap.podsklopoviError) {
    return `
      <section class="form-card" style="margin-bottom:14px">
        <div class="pp-toolbar" style="margin:0 0 12px">
          <button type="button" class="pp-refresh-btn" id="ppPredmetBackBtn">← Nazad na listu predmeta</button>
        </div>
        ${tabs}
        <p class="pp-error">${escHtml(ap.podsklopoviError)}</p>
        <button type="button" class="btn btn-ghost" id="ppPodsklopRetry">Pokušaj ponovo</button>
      </section>
    `;
  }

  const flat = ap.podsklopovi || [];
  const itemId = ap.selectedItemId;
  let expanded = loadExpandedSet(itemId);
  const rootRows = rootsOf(flat);
  if (!expanded.size && rootRows.length) {
    expanded = new Set(rootRows.map((r) => rowKey(r)));
    saveExpandedSet(itemId, expanded);
  }

  const body = rootRows.map((root) => {
    const k = rowKey(root);
    const open = expanded.has(k);
    const hc = hasChildren(flat, root);
    const toggle = hc
      ? `<button type="button" class="pp-tree-toggle" data-tree-key="${escHtml(k)}" aria-expanded="${open ? 'true' : 'false'}">${open ? '▼' : '▶'}</button>`
      : '<span class="pp-tree-toggle-spacer"></span>';
    const label = `${escHtml(String(root.ident_broj || ''))} — ${escHtml(String(root.naziv_dela || ''))}`;
    const mes = root.is_mes_aktivan ? '<span class="pp-counter">MES</span>' : '';
    const st = root.status_rn === true || root.status_rn === false
      ? `<span class="pp-counter">${root.status_rn ? 'akt.' : 'neakt.'}</span>`
      : '';
    const nested = hc && open ? renderRowsHtml(flat, expanded, 1, root) : '';
    return `
      <tr class="pp-tree-row" data-tree-key="${escHtml(k)}">
        <td class="pp-tree-cell" style="padding-left:18px">
          ${toggle}
          <span class="pp-tree-label pp-pickable-rn-tree" data-bigtehn-id="${escHtml(String(root.legacy_idrn ?? root.rn_id))}" style="cursor:pointer">${label}</span>
          ${mes}${st}
        </td>
      </tr>
      ${nested}`;
  }).join('');

  const treeBlock = (ap.activePredmetTab || 'stablo') !== 'stablo'
    ? '<p class="form-hint" style="margin:8px 0 0">Stablo je na tabu „Stablo”. Ispod je tabela praćenja.</p>'
    : `
      <div class="pp-table-wrap" style="max-height:min(65vh,640px);overflow:auto">
        <table class="pp-table" id="ppPodsklopTable">
          <tbody>${body || '<tr><td class="form-hint">Nema redova u strukturi za ovaj predmet.</td></tr>'}</tbody>
        </table>
      </div>`;

  return `
    <section class="form-card" style="margin-bottom:14px">
      <div class="pp-toolbar" style="margin:0 0 12px">
        <button type="button" class="pp-refresh-btn" id="ppPredmetBackBtn">← Nazad na listu predmeta</button>
      </div>
      ${tabs}
      <h2 class="form-section-title" style="margin:0 0 4px">${naz}</h2>
      <p class="form-hint" style="margin:0 0 14px">${bp}${kom ? ` · ${kom}` : ''}</p>
      ${treeBlock}
    </section>
  `;
}

export function wirePodsklopoviTree(container, state, renderShell) {
  const ap = state.aktivniPredmetiState || {};
  const itemId = ap.selectedItemId;

  wirePredmetTabs(container, state, renderShell);

  container.querySelector('#ppPredmetBackBtn')?.addEventListener('click', () => {
    clearSelectedPredmet();
    renderShell();
  });
  container.querySelector('#ppPodsklopRetry')?.addEventListener('click', () => {
    void selectPredmet(itemId).then(() => renderShell());
  });

  container.querySelectorAll('.pp-tree-toggle').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      const key = btn.getAttribute('data-tree-key');
      if (!key || itemId == null) return;
      const set = loadExpandedSet(itemId);
      if (set.has(key)) set.delete(key);
      else set.add(key);
      saveExpandedSet(itemId, set);
      ev.stopPropagation();
      renderShell();
    });
  });

  container.querySelectorAll('.pp-pickable-rn-tree').forEach((el) => {
    el.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const id = Number(el.getAttribute('data-bigtehn-id'));
      if (!Number.isFinite(id) || id <= 0) return;
      try {
        const uuid = await ensureRadniNalogFromBigtehn(id);
        const params = new URLSearchParams(window.location.search);
        if (itemId != null) params.set('predmet', String(itemId));
        const root = ap.izvestajRootRnId;
        if (root != null && root > 0) params.set('root', String(root));
        else params.delete('root');
        params.set('rn', uuid);
        const hash = window.location.hash || '#tab=po_pozicijama';
        history.pushState(null, '', `${window.location.pathname}?${params.toString()}${hash}`);
        const ok = await loadPracenje(uuid);
        if (ok) startRealtime();
        renderShell();
      } catch (e) {
        console.error(e);
        window.alert(e?.message || String(e));
      }
    });
  });
}
