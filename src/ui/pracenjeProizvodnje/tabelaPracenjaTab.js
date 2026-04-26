/**
 * Tab „Tabela praćenja” — predmet kontekst (?predmet= + #tab=tabela_pracenja).
 */

import { escHtml } from '../../lib/dom.js';
import { getBigtehnDrawingSignedUrl } from '../../services/drawings.js';
import { ensureRadniNalogFromBigtehn } from '../../services/pracenjeProizvodnje.js';
import {
  canEditPracenjeNapomenu,
  loadPredmetIzvestaj,
  loadPracenje,
  savePracenjeIzvestajNapomena,
  setActivePredmetTab,
  setIzvestajFilter,
  setIzvestajLotQty,
  setIzvestajRootRnId,
  startRealtime,
  toggleIzvestajMatrixView,
  toggleIzvestajRowExpanded,
} from '../../state/pracenjeProizvodnjeState.js';
import { replacePracenjePredmetUrl } from './pracenjeRouter.js';
import {
  exportPracenjeIzvestajExcel,
  exportPracenjeIzvestajPdf,
} from '../../services/pracenjeIzvestajExport.js';

export function predmetTabsStripHtml(activePredmetTab) {
  const tabs = [
    { id: 'stablo', label: 'Stablo', icon: '🌳' },
    { id: 'tabela_pracenja', label: 'Tabela praćenja', icon: '▦' },
  ];
  return `
    <nav class="kadrovska-tabs" role="tablist" aria-label="Prikaz predmeta" style="margin:0 0 12px">
      ${tabs.map(t => `
        <button type="button" role="tab"
          class="kadrovska-tab${t.id === activePredmetTab ? ' is-active' : ''}"
          data-predmet-tab="${escHtml(t.id)}"
          aria-selected="${t.id === activePredmetTab ? 'true' : 'false'}">
          <span aria-hidden="true">${escHtml(t.icon)}</span> ${escHtml(t.label)}
        </button>
      `).join('')}
    </nav>
  `;
}

export function wirePredmetTabs(container, state, renderShell) {
  const ap = state.aktivniPredmetiState || {};
  const itemId = ap.selectedItemId;
  container.querySelectorAll('[data-predmet-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.predmetTab;
      if (!tab) return;
      setActivePredmetTab(tab);
      replacePracenjePredmetUrl({
        predmetItemId: itemId,
        rootRnId: ap.izvestajRootRnId,
        hashTab: tab,
      });
      if (tab === 'tabela_pracenja') {
        void loadPredmetIzvestaj().then(() => renderShell());
      } else {
        renderShell();
      }
    });
  });
}

function formatNum(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return String(n);
}

function rowProblemClass(st) {
  if (!st) return '';
  const bad = st.kasni || st.nema_tp || st.nema_crtez || st.nema_zavrsnu_kontrolu
    || st.nije_kompletirano || st.nema_rn;
  return bad ? ' pp-izv-row--warn' : '';
}

function filterRows(rows, filter) {
  if (!Array.isArray(rows)) return [];
  if (filter === 'sve') return rows;
  return rows.filter((r) => {
    const s = r.statusi || {};
    switch (filter) {
      case 'nije_kompletirano': return !!s.nije_kompletirano;
      case 'nema_tp': return !!s.nema_tp;
      case 'nema_crtez': return !!s.nema_crtez;
      case 'nema_zavrsnu_kontrolu': return !!s.nema_zavrsnu_kontrolu;
      case 'kasni': return !!s.kasni;
      case 'ima_napomenu': return String(r.korisnicka_napomena || r.sistemska_napomena || '').trim().length > 0;
      default: return true;
    }
  });
}

function maxOpSlots(rows) {
  let m = 0;
  for (const r of rows || []) {
    const ops = r.operations;
    if (Array.isArray(ops)) m = Math.max(m, ops.length);
  }
  return m;
}

function opsSummary(row) {
  const ops = row.operations;
  if (!Array.isArray(ops) || !ops.length) return '—';
  const fin = ops.filter(o => o.is_final_control);
  const lastFin = fin.length ? fin[fin.length - 1] : null;
  const tail = lastFin
    ? ` · završna ${formatNum(lastFin.completed_qty)}/${formatNum(lastFin.planned_qty)}`
    : '';
  return `${ops.length} operacija${tail}`;
}

export function tabelaPracenjaMainHtml(state) {
  const ap = state.aktivniPredmetiState || {};
  const hid = ap.headerPredmet || {};
  const pred = ap.izvestaj?.predmet || {};
  const titleBroj = escHtml(String(pred.broj_predmeta || hid.broj_predmeta || ''));
  const titleNaz = escHtml(String(pred.naziv_predmeta || hid.naziv_predmeta || 'Predmet'));
  const data = ap.izvestaj;
  const rowsAll = data?.rows || [];
  const rows = filterRows(rowsAll, ap.izvestajFilter || 'sve');
  const root = data?.root;
  const lot = ap.izvestajLotQty ?? 12;
  const matrix = !!ap.izvestajMatrixView;
  const nSlots = maxOpSlots(rows);
  const flat = ap.podsklopovi || [];

  const scopeOptions = [
    { v: '', t: 'Ceo predmet' },
    ...flat.map((r) => ({
      v: String(r.rn_id),
      t: `${r.ident_broj || r.rn_id} — ${String(r.naziv_dela || '').slice(0, 80)}`,
    })),
  ];

  const filterOpts = [
    ['sve', 'Sve'],
    ['nije_kompletirano', 'Nije kompletirano'],
    ['nema_tp', 'Nema TP'],
    ['nema_crtez', 'Nema crtež'],
    ['nema_zavrsnu_kontrolu', 'Nema završnu kontrolu'],
    ['kasni', 'Kasni'],
    ['ima_napomenu', 'Ima napomenu'],
  ];

  const err = ap.izvestajError
    ? `<div class="pp-error" style="margin-bottom:10px">${escHtml(ap.izvestajError)}</div>`
    : '';

  const loading = ap.izvestajLoading
    ? '<p class="form-hint">Učitavanje izveštaja…</p>'
    : '';

  const matrixHdr = matrix && nSlots > 0
    ? Array.from({ length: nSlots }, (_, i) => {
      const j = i + 1;
      return `
        <th>Operacija ${j}</th>
        <th>Kol. ${j}</th>`;
    }).join('')
    : '';

  const tableBody = !data && !ap.izvestajLoading
    ? '<tr><td colspan="20" class="form-hint">Klikni „Osveži” ili otvori ponovo tab.</td></tr>'
    : rows.map((r) => {
      const st = r.statusi || {};
      const indent = 12 + Number(r.level || 0) * 16;
      const exp = ap.izvestajExpandedNodeIds?.[String(r.node_id)];
      const opCol = matrix
        ? Array.from({ length: nSlots }, (_, i) => {
          const o = (r.operations || [])[i];
          if (!o) return '<td>—</td><td>—</td>';
          const nm = escHtml(String(o.naziv || ''));
          const pq = formatNum(o.planned_qty);
          const cq = formatNum(o.completed_qty);
          return `<td title="${nm}">${nm.slice(0, 24)}${nm.length > 24 ? '…' : ''}</td><td>${escHtml(cq)}/${escHtml(pq)}</td>`;
        }).join('')
        : `<td>${escHtml(opsSummary(r))}</td>`;

      const noteRO = canEditPracenjeNapomenu()
        ? `<textarea class="pp-izv-note" rows="2" data-note-node="${escHtml(String(r.node_id))}" data-note-rn="${escHtml(r.rn_id || '')}">${escHtml(r.korisnicka_napomena || '')}</textarea>
           <button type="button" class="pp-refresh-btn pp-izv-save-note" data-save-node="${escHtml(String(r.node_id))}">Sačuvaj</button>`
        : `<span class="form-hint">${escHtml(r.korisnicka_napomena || '—')}</span>`;

      const sys = r.sistemska_napomena ? `<span class="form-hint">${escHtml(r.sistemska_napomena)}</span> ` : '';

      const statusBits = [
        st.kasni && 'Kasni',
        st.nema_tp && 'Nema TP',
        st.nema_crtez && 'Nema crtež',
        st.nema_zavrsnu_kontrolu && 'Nema ZK',
        st.nije_kompletirano && 'Nije kompl.',
        st.nema_rn && 'Nema RN',
      ].filter(Boolean).join(', ') || 'OK';

      const drawCell = r.crtez_drawing_no
        ? `<button type="button" class="btn btn-ghost pp-izv-drawing" style="padding:2px 6px" data-drawing="${escHtml(r.crtez_drawing_no)}"
             ${r.has_crtez_file ? '' : 'disabled title="Nema fajla u kešu"'}>${escHtml(r.broj_crteza || r.crtez_drawing_no)}</button>`
        : `<span class="form-hint">Nema</span>`;

      const sklopCell = r.sklop_drawing_no
        ? `<button type="button" class="btn btn-ghost pp-izv-drawing" style="padding:2px 6px" data-drawing="${escHtml(r.sklop_drawing_no)}"
             ${r.has_skop_crtez_file ? '' : 'disabled title="Nema fajla u kešu"'}>${escHtml(r.broj_sklopnog_crteza || r.sklop_drawing_no)}</button>`
        : `<span class="form-hint">—</span>`;

      const rnBtn = `<button type="button" class="btn btn-ghost pp-izv-open-rn" style="padding:2px 6px" data-bigtehn-rn="${escHtml(String(r.node_id))}">${escHtml(r.rn_broj || '')}</button>`;

      const colCount = 16 + (matrix ? nSlots * 2 : 1);
      const det = exp && Array.isArray(r.operations) && r.operations.length
        ? `<tr class="pp-izv-detail"><td colspan="${colCount}">
            <table class="pp-table" style="margin:8px 0;font-size:12px">
              <thead><tr><th>Rb</th><th>Operacija</th><th>Mašina</th><th>Plan</th><th>Urađeno</th><th>Datum</th><th>Kontrola</th></tr></thead>
              <tbody>
              ${r.operations.map((o) => `
                <tr>
                  <td>${escHtml(String(o.redosled ?? ''))}</td>
                  <td>${escHtml(String(o.naziv ?? ''))}</td>
                  <td>${escHtml(String(o.masina ?? ''))}</td>
                  <td>${escHtml(formatNum(o.planned_qty))}</td>
                  <td>${escHtml(formatNum(o.completed_qty))}</td>
                  <td>${escHtml(o.completed_at ? String(o.completed_at).slice(0, 10) : '—')}</td>
                  <td>${escHtml(String(o.kontrola_status ?? ''))}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </td></tr>`
        : '';

      return `
        <tr class="pp-izv-row${rowProblemClass(st)}" data-node="${escHtml(String(r.node_id))}">
          <td style="position:sticky;left:0;background:var(--surface1);z-index:1;min-width:200px;padding-left:${indent}px">
            <button type="button" class="btn btn-ghost pp-izv-toggle" data-exp="${escHtml(String(r.node_id))}" style="padding:2px 6px">${exp ? '▼' : '▶'}</button>
            ${escHtml(r.naziv_pozicije || '')}
          </td>
          <td>${drawCell}</td>
          <td>${sklopCell}</td>
          <td>${rnBtn}</td>
          <td>${escHtml(formatNum(r.lansirana_kolicina))}</td>
          <td>${escHtml(formatNum(r.zavrsena_kolicina))}</td>
          <td>${r.required_for_lot == null ? '<span class="form-hint">N/A</span>' : escHtml(formatNum(r.required_for_lot))}</td>
          <td>${escHtml(formatNum(r.raspolozivo_za_montazu))} / ${escHtml(formatNum(r.kompletirano_za_lot))}</td>
          <td>${escHtml(r.datum_lansiranja_tp || '—')}</td>
          <td>${escHtml(r.datum_izrade || '—')}</td>
          <td style="max-width:140px;font-size:11px">${escHtml(r.masinska_obrada_status || '—')}</td>
          <td style="max-width:140px;font-size:11px">${escHtml(r.povrsinska_zastita_status || '—')}</td>
          <td>${escHtml(r.materijal || '—')}</td>
          <td>${escHtml(r.dimenzije || '—')}</td>
          <td style="min-width:160px">${sys}${noteRO}</td>
          <td style="font-size:12px">${escHtml(statusBits)}</td>
          ${opCol}
        </tr>
        ${det}`;
    }).join('');

  return `
    <section class="form-card" style="margin-bottom:14px">
      <div class="pp-toolbar" style="flex-wrap:wrap;gap:10px;align-items:flex-end">
        <div>
          <div class="form-hint" style="margin:0 0 4px">Izveštaj</div>
          <strong>Praćenje proizvodnje — ${titleBroj} ${titleNaz}</strong>
          ${root ? `<div class="form-hint">Opseg: ${escHtml(root.naziv || '')}</div>` : ''}
        </div>
        <label class="pp-rn-filter">Opseg
          <select id="ppIzvScope">
            ${scopeOptions.map((o) => {
              const sel = ap.izvestajRootRnId != null
                ? String(ap.izvestajRootRnId) === o.v
                : o.v === '';
              return `<option value="${escHtml(o.v)}"${sel ? ' selected' : ''}>${escHtml(o.t)}</option>`;
            }).join('')}
          </select>
        </label>
        <label class="pp-rn-filter">Lot
          <input type="number" id="ppIzvLot" min="1" max="100000" step="1" value="${escHtml(String(lot))}" style="width:88px">
        </label>
        <label class="pp-rn-filter">Filter
          <select id="ppIzvFilter">
            ${filterOpts.map(([v, t]) => `<option value="${escHtml(v)}"${ap.izvestajFilter === v ? ' selected' : ''}>${escHtml(t)}</option>`).join('')}
          </select>
        </label>
        <button type="button" class="pp-refresh-btn" id="ppIzvRefresh">Osveži</button>
        <button type="button" class="pp-refresh-btn" id="ppIzvExcel">Izvezi Excel</button>
        <button type="button" class="pp-refresh-btn" id="ppIzvPdf">Izvezi PDF</button>
        <label class="pp-rn-filter" style="display:flex;align-items:center;gap:6px">
          <input type="checkbox" id="ppIzvMatrix" ${matrix ? 'checked' : ''}>
          Matrični prikaz
        </label>
      </div>
      ${err}
      ${loading}
      <div class="pp-table-wrap" style="max-height:min(72vh,800px);overflow:auto;margin-top:12px">
        <table class="pp-table pp-izv-table" style="min-width:1200px">
          <thead style="position:sticky;top:0;z-index:2;background:var(--surface2)">
            <tr>
              <th style="position:sticky;left:0;z-index:3;background:var(--surface2);min-width:200px">Pozicija</th>
              <th>Crtež</th>
              <th>Sklop</th>
              <th>RN</th>
              <th>Lans.</th>
              <th>Završ.</th>
              <th>Za lot</th>
              <th>Rasp./lot</th>
              <th>Lans. TP</th>
              <th>Rok izr.</th>
              <th>Maš. obr.</th>
              <th>Povr. zašt.</th>
              <th>Mater.</th>
              <th>Dim.</th>
              <th>Napomena</th>
              <th>Status</th>
              ${matrix ? matrixHdr : '<th>Operacije</th>'}
            </tr>
          </thead>
          <tbody>${tableBody}</tbody>
        </table>
      </div>
      ${data?.summary ? `<p class="form-hint" style="margin-top:10px">Redova: ${data.summary.total_rows ?? rows.length} · Lansirano: ${formatNum(data.summary.total_lansirano)} · Završeno: ${formatNum(data.summary.total_zavrseno)} · Lot: ${lot}</p>` : ''}
    </section>
  `;
}

export function wireTabelaPracenja(container, state, renderShell) {
  const ap = state.aktivniPredmetiState || {};
  const itemId = ap.selectedItemId;

  container.querySelector('#ppIzvRefresh')?.addEventListener('click', () => {
    void loadPredmetIzvestaj().then(() => renderShell());
  });

  container.querySelector('#ppIzvLot')?.addEventListener('change', (ev) => {
    const v = Number(ev.target.value);
    if (Number.isFinite(v) && v > 0) {
      setIzvestajLotQty(v);
      void loadPredmetIzvestaj().then(() => renderShell());
    }
  });

  container.querySelector('#ppIzvScope')?.addEventListener('change', (ev) => {
    const v = ev.target.value;
    setIzvestajRootRnId(v === '' ? null : Number(v));
    replacePracenjePredmetUrl({
      predmetItemId: itemId,
      rootRnId: v === '' ? null : Number(v),
      hashTab: 'tabela_pracenja',
    });
    void loadPredmetIzvestaj().then(() => renderShell());
  });

  container.querySelector('#ppIzvFilter')?.addEventListener('change', (ev) => {
    setIzvestajFilter(ev.target.value);
    renderShell();
  });

  container.querySelector('#ppIzvMatrix')?.addEventListener('change', () => {
    toggleIzvestajMatrixView();
    renderShell();
  });

  container.querySelector('#ppIzvExcel')?.addEventListener('click', () => {
    void exportPracenjeIzvestajExcel(state).catch((e) => window.alert(e?.message || String(e)));
  });

  container.querySelector('#ppIzvPdf')?.addEventListener('click', () => {
    void exportPracenjeIzvestajPdf(state).catch((e) => window.alert(e?.message || String(e)));
  });

  container.querySelectorAll('.pp-izv-toggle').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = btn.getAttribute('data-exp');
      if (id) toggleIzvestajRowExpanded(id);
      renderShell();
    });
  });

  container.querySelectorAll('.pp-izv-drawing').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      const d = btn.getAttribute('data-drawing');
      if (!d) return;
      try {
        const url = await getBigtehnDrawingSignedUrl(d);
        if (url) window.open(url, '_blank', 'noopener,noreferrer');
      } catch (e) {
        window.alert(e?.message || String(e));
      }
    });
  });

  container.querySelectorAll('.pp-izv-open-rn').forEach((btn) => {
    btn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      const id = Number(btn.getAttribute('data-bigtehn-rn'));
      if (!Number.isFinite(id) || id <= 0) return;
      try {
        const uuid = await ensureRadniNalogFromBigtehn(id);
        const params = new URLSearchParams(window.location.search);
        if (itemId != null) params.set('predmet', String(itemId));
        const root = ap.izvestajRootRnId;
        if (root != null && root > 0) params.set('root', String(root));
        else params.delete('root');
        params.set('rn', uuid);
        const hash = '#tab=po_pozicijama';
        history.pushState(null, '', `${window.location.pathname}?${params.toString()}${hash}`);
        const ok = await loadPracenje(uuid);
        if (ok) startRealtime();
        renderShell();
      } catch (e) {
        window.alert(e?.message || String(e));
      }
    });
  });

  container.querySelectorAll('.pp-izv-save-note').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const node = btn.getAttribute('data-save-node');
      const ta = [...container.querySelectorAll('textarea.pp-izv-note')].find(
        (x) => x.getAttribute('data-note-node') === node,
      );
      const rn = ta?.getAttribute('data-note-rn') || '';
      if (!node) return;
      try {
        await savePracenjeIzvestajNapomena({
          bigtehnRnId: Number(node),
          note: ta?.value || '',
          rnUuid: rn && /^[0-9a-f-]{36}$/i.test(rn) ? rn : null,
        });
        renderShell();
      } catch (e) {
        const msg = e?.message || String(e);
        if (/forbidden|42501|403/i.test(msg)) {
          window.alert('Nemaš pravo izmene napomene.');
        } else {
          window.alert(msg);
        }
      }
    });
  });
}
