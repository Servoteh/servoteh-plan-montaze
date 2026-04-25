/**
 * Lokacije — tab „Štampa nalepnica" (Task 3b).
 *
 * Pun-ekran zamena za popup `openTechProcessLabelPrintModal`. Razlika:
 *
 *   - **Multi-select** preko vise predmeta i njihovih TP-ova istovremeno.
 *   - **Print queue** (red za štampu) na dnu — svaka stavka može imati
 *     svoju količinu (default 1).
 *   - **Batch print** — ceo queue se šalje u jedan otisak (više fizičkih
 *     nalepnica izlazi iz TSC-a u nizu).
 *
 * In-memory state (NE persistira u localStorage — queue treba da nestane
 * pri logout-u / page reload-u, kao što je traženo):
 *   - `_state.itemsRows`            poslednji rezultat pretrage predmeta
 *   - `_state.focusedItemId`        koji je predmet trenutno otvoren u
 *                                   donjem panelu (TP lista)
 *   - `_state.tpsByItem`            cache: itemId → TP[] (jednokratni fetch)
 *   - `_state.queue`                Map<itemId:tpId, queueEntry>
 *   - `_state.lastSearch`           tekst poslednje pretrage (sačuva se u
 *                                   tabu kad korisnik prebaci tab i vrati se)
 *
 * Reuse:
 *   - `searchBigtehnItems` iz `services/lokacije.js` — isti RPC kao
 *     „Pregled predmeta" tab. Ne fork-ujemo komponentu (vidi
 *     `docs/labels/02-visual-spec.md` § 7), nego koristimo isti data
 *     source i zadržavamo tabularni render specifičan za ovu stranicu
 *     (potrebne su nam checkbox kolone + interakcija sa donjim panelom).
 *   - `searchBigtehnWorkOrdersForItem` — isti fetcher koji koristi popup.
 *   - `printTechProcessLabelsBatch` — naš novi batch printer iz `labelsPrint.js`.
 */

import { escHtml, showToast } from '../../lib/dom.js';
import {
  searchBigtehnItems,
  searchBigtehnWorkOrdersForItem,
} from '../../services/lokacije.js';
import { formatBigTehnRnzBarcode } from '../../lib/barcodeParse.js';
import { printTechProcessLabelsBatch } from './labelsPrint.js';

/**
 * @typedef {object} QueueEntry
 * @property {object} predmet   Snapshot bigtehn_items_cache row (id, broj_predmeta, naziv_predmeta, customer_name)
 * @property {object} tp        Snapshot aktivnog RN-a (id, ident_broj, broj_crteza, naziv_dela, materijal, komada)
 * @property {number} qty       Količina nalepnica za štampu (>=1)
 */

/** In-memory state — preživljava prebacivanje tab-ova ali ne reload. */
const _state = {
  /** @type {Array<object>} */ itemsRows: [],
  /** @type {number|null} */ focusedItemId: null,
  /** @type {Map<number, Array<object>>} */ tpsByItem: new Map(),
  /** @type {Map<string, QueueEntry>} */ queue: new Map(),
  /** @type {string} */ lastSearch: '',
  /** @type {boolean} */ loading: false,
};

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function todayStrDDMMYY() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${String(d.getFullYear()).slice(-2)}`;
}

function queueKey(itemId, tpId) { return `${itemId}:${tpId}`; }

/**
 * Glavni ulaz — render-uje stranu „Štampa nalepnica" u dati host.
 *
 * @param {HTMLElement} host
 * @param {{ onRefresh?: () => void|Promise<void> }} [opts]
 */
export async function renderLabelsPrintPage(host, { onRefresh } = {}) {
  if (!host) return;
  const refresh = typeof onRefresh === 'function' ? onRefresh : () => renderLabelsPrintPage(host, { onRefresh });

  /* Render shell odmah pa fetch — odziv je trenutan i operater vidi search
   * + queue od starta. */
  host.innerHTML = `
    <div class="kadr-panel active loc-panel">
      <h2 class="loc-subh" style="margin:0 0 6px;letter-spacing:0.5px">ŠTAMPA NALEPNICA — BATCH</h2>
      <p class="loc-muted" style="margin:0 0 14px">
        Izaberi jedan ili više predmeta iz tabele (čekiraj kvadrat). Klik na red prikazuje sve njegove tehnološke postupke u donjem panelu — čekiraj TP-ove koje želiš da odštampaš.
        Ceo „Red za štampu" odlazi u jedan otisak.
      </p>

      ${renderItemsBlock()}

      <h3 class="loc-subh" style="margin:18px 0 6px">Tehnološki postupci izabranog predmeta</h3>
      <div id="lpTpsHost"></div>

      <h3 class="loc-subh" style="margin:18px 0 6px">Red za štampu</h3>
      <div id="lpQueueHost"></div>
    </div>`;

  attachItemsHandlers(host, refresh);
  renderTpsBlock(host, refresh);
  renderQueueBlock(host, refresh);

  /* Učitaj items na osnovu lastSearch (ili prazan upit za top 100). */
  await refreshItemsList(host, _state.lastSearch, refresh);
}

/* ── Items block ──────────────────────────────────────────────────────── */

function renderItemsBlock() {
  return `
    <div class="loc-predmet-picker" style="display:flex;flex-direction:column;gap:10px">
      <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
        <label class="loc-filter-field" style="flex:1;min-width:280px;max-width:520px">
          <span>Pretraga predmeta (br. predmeta · naziv · ugovor · narudžbenica)</span>
          <input type="search" id="lpItemsQ" class="loc-search-input"
            value="${escHtml(_state.lastSearch)}"
            placeholder="npr. 7351, 'Perun', NAR-..."
            autocomplete="off" />
        </label>
        <span class="loc-muted" id="lpItemsCount" style="font-size:12px;padding-bottom:4px">—</span>
      </div>
      <div class="loc-table-wrap" style="max-height:36vh;overflow:auto">
        <table class="loc-table">
          <thead>
            <tr>
              <th style="width:36px"></th>
              <th>Predmet</th>
              <th>Naziv</th>
              <th>Komitent</th>
              <th>Ugovor / NAR</th>
              <th>Rok</th>
            </tr>
          </thead>
          <tbody id="lpItemsRows">
            <tr><td colspan="6" class="loc-muted" style="padding:18px;text-align:center">Učitavam predmete…</td></tr>
          </tbody>
        </table>
      </div>
    </div>`;
}

function attachItemsHandlers(host, refresh) {
  const input = host.querySelector('#lpItemsQ');
  if (!input) return;
  const onChange = debounce(() => {
    _state.lastSearch = input.value;
    refreshItemsList(host, input.value, refresh);
  }, 220);
  input.addEventListener('input', onChange);
  input.focus();
}

async function refreshItemsList(host, q, refresh) {
  const tbody = host.querySelector('#lpItemsRows');
  const countEl = host.querySelector('#lpItemsCount');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="6" class="loc-muted" style="padding:14px;text-align:center">Učitavam…</td></tr>`;
  let rows;
  try {
    rows = await searchBigtehnItems(q, 100);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="loc-warn" style="padding:14px">Greška: ${escHtml(err?.message || String(err))}</td></tr>`;
    if (countEl) countEl.textContent = '—';
    return;
  }
  _state.itemsRows = Array.isArray(rows) ? rows : [];
  if (countEl) countEl.textContent = `${_state.itemsRows.length} predmet${_state.itemsRows.length === 1 ? '' : 'a'}`;
  if (!_state.itemsRows.length) {
    const msg = q ? 'Nema predmeta za zadati upit.' : 'Nema aktuelnih predmeta („U TOKU").';
    tbody.innerHTML = `<tr><td colspan="6" class="loc-muted" style="padding:14px;text-align:center">${escHtml(msg)}</td></tr>`;
    return;
  }
  tbody.innerHTML = _state.itemsRows.map(renderItemRowHtml).join('');
  attachItemRowHandlers(host, refresh);
}

function renderItemRowHtml(item) {
  const code = escHtml(item.broj_predmeta || '');
  const naz = escHtml(String(item.naziv_predmeta || '').slice(0, 80));
  const cust = escHtml(item.customer_name || '—');
  const ugnar = [item.broj_ugovora, item.broj_narudzbenice]
    .filter(Boolean)
    .map(s => escHtml(String(s)))
    .join(' · ') || '—';
  const rok = item.rok_zavrsetka ? escHtml(String(item.rok_zavrsetka).slice(0, 10)) : '—';
  const isFocused = _state.focusedItemId === item.id;
  const focusedCls = isFocused ? ' loc-row-active' : '';
  const hasInQueue = anyQueuedForItem(item.id);
  const checkedAttr = hasInQueue ? ' checked' : '';
  return `
    <tr class="loc-row-click${focusedCls}" data-lp-item-id="${escHtml(String(item.id))}"
        title="Klik na red prikazuje TP-ove ovog predmeta u panelu ispod. Čekboks fokusira red bez klika.">
      <td style="text-align:center" data-lp-stop>
        <input type="checkbox" class="lp-item-cb" data-lp-item-cb="${escHtml(String(item.id))}"${checkedAttr}
          title="Otvara TP listu za ovaj predmet (isto kao klik na red)" />
      </td>
      <td><strong>${code}</strong></td>
      <td>${naz}</td>
      <td>${cust}</td>
      <td>${ugnar}</td>
      <td>${rok}</td>
    </tr>`;
}

function anyQueuedForItem(itemId) {
  for (const k of _state.queue.keys()) {
    if (k.startsWith(`${itemId}:`)) return true;
  }
  return false;
}

function attachItemRowHandlers(host, refresh) {
  host.querySelectorAll('[data-lp-item-id]').forEach(tr => {
    tr.addEventListener('click', ev => {
      /* Sklopljen čekboks/dugme u redu → ne pokreće row click. */
      if (ev.target.closest('[data-lp-stop]')) return;
      const id = Number(tr.getAttribute('data-lp-item-id'));
      if (!Number.isFinite(id)) return;
      focusItem(host, id, refresh);
    });
  });
  host.querySelectorAll('[data-lp-item-cb]').forEach(cb => {
    cb.addEventListener('click', ev => {
      ev.stopPropagation();
      const id = Number(cb.getAttribute('data-lp-item-cb'));
      if (Number.isFinite(id)) focusItem(host, id, refresh);
    });
  });
}

function focusItem(host, itemId, refresh) {
  _state.focusedItemId = itemId;
  /* Update vizuelni focus na items tabeli */
  host.querySelectorAll('[data-lp-item-id]').forEach(tr => {
    const on = Number(tr.getAttribute('data-lp-item-id')) === itemId;
    tr.classList.toggle('loc-row-active', on);
  });
  renderTpsBlock(host, refresh);
}

/* ── TPs block (donji panel za izabrani predmet) ──────────────────────── */

async function renderTpsBlock(host, refresh) {
  const hostEl = host.querySelector('#lpTpsHost');
  if (!hostEl) return;
  const itemId = _state.focusedItemId;
  if (!itemId) {
    hostEl.innerHTML = `<p class="loc-muted" style="padding:14px;border:1px dashed var(--border2,#ccc);border-radius:6px">
      Izaberi predmet u tabeli iznad da vidiš njegove tehnološke postupke.
    </p>`;
    return;
  }
  const item = _state.itemsRows.find(r => r.id === itemId);
  if (!item) {
    hostEl.innerHTML = `<p class="loc-warn" style="padding:14px">Predmet nije pronađen u trenutnoj listi pretrage.</p>`;
    return;
  }
  /* Učitaj TP-ove ako nisu već u kešu */
  if (!_state.tpsByItem.has(itemId)) {
    hostEl.innerHTML = `<p class="loc-muted" style="padding:14px">Učitavam tehnološke postupke za <strong>${escHtml(item.broj_predmeta || '')}</strong>…</p>`;
    try {
      const tps = await searchBigtehnWorkOrdersForItem(itemId, { onlyOpen: true, limit: 500 });
      _state.tpsByItem.set(itemId, Array.isArray(tps) ? tps : []);
    } catch (err) {
      hostEl.innerHTML = `<p class="loc-warn" style="padding:14px">Greška učitavanja TP: ${escHtml(err?.message || String(err))}</p>`;
      return;
    }
  }
  const tps = _state.tpsByItem.get(itemId) || [];
  if (!tps.length) {
    hostEl.innerHTML = `<p class="loc-muted" style="padding:14px;border:1px dashed var(--border2,#ccc);border-radius:6px">
      Predmet <strong>${escHtml(item.broj_predmeta || '')}</strong> nema aktivnih radnih naloga u MES listi.
    </p>`;
    return;
  }

  const headerHtml = `
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 0 8px">
      <div style="flex:1;min-width:0">
        <div><strong>${escHtml(item.broj_predmeta || '')}</strong> · ${escHtml(item.naziv_predmeta || '')}</div>
        <div class="loc-muted" style="font-size:12px">Komitent: ${escHtml(item.customer_name || '—')}</div>
      </div>
      <button type="button" class="btn btn-xs" id="lpTpsSelectAll"
        title="Dodaj sve TP-ove ovog predmeta u red za štampu (kvantitet = 1 za svaki)">+ Sve TP u red</button>
      <button type="button" class="btn btn-xs" id="lpTpsClearItem"
        title="Ukloni sve TP-ove ovog predmeta iz reda za štampu">Očisti red za ovaj predmet</button>
    </div>`;

  const rowsHtml = tps.map(wo => renderTpRowHtml(itemId, wo)).join('');

  hostEl.innerHTML = `
    ${headerHtml}
    <div class="loc-table-wrap" style="max-height:32vh;overflow:auto">
      <table class="loc-table">
        <thead>
          <tr>
            <th style="width:36px"></th>
            <th>RN (ident)</th>
            <th>Crtež</th>
            <th>Naziv dela</th>
            <th class="loc-qty-cell">Komada</th>
            <th>Materijal</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`;

  /* Handler-i */
  hostEl.querySelectorAll('[data-lp-tp-cb]').forEach(cb => {
    cb.addEventListener('change', () => {
      const tpId = Number(cb.getAttribute('data-lp-tp-cb'));
      const wo = tps.find(x => x.id === tpId);
      if (!wo) return;
      const k = queueKey(itemId, tpId);
      if (cb.checked) {
        _state.queue.set(k, { predmet: item, tp: wo, qty: 1 });
      } else {
        _state.queue.delete(k);
      }
      renderQueueBlock(host, refresh);
      /* Update items tabela jer se promenio "imam u redu" indikator. */
      refreshItemRowAppearance(host, itemId);
    });
  });
  hostEl.querySelector('#lpTpsSelectAll')?.addEventListener('click', () => {
    for (const wo of tps) {
      const k = queueKey(itemId, wo.id);
      if (!_state.queue.has(k)) {
        _state.queue.set(k, { predmet: item, tp: wo, qty: 1 });
      }
    }
    renderTpsBlock(host, refresh);
    renderQueueBlock(host, refresh);
    refreshItemRowAppearance(host, itemId);
  });
  hostEl.querySelector('#lpTpsClearItem')?.addEventListener('click', () => {
    for (const k of Array.from(_state.queue.keys())) {
      if (k.startsWith(`${itemId}:`)) _state.queue.delete(k);
    }
    renderTpsBlock(host, refresh);
    renderQueueBlock(host, refresh);
    refreshItemRowAppearance(host, itemId);
  });
}

function renderTpRowHtml(itemId, wo) {
  const k = queueKey(itemId, wo.id);
  const inQueue = _state.queue.has(k);
  const checkedAttr = inQueue ? ' checked' : '';
  const idb = escHtml(String(wo.ident_broj || ''));
  const cr = escHtml(String(wo.broj_crteza || '—'));
  const nz = escHtml(String(wo.naziv_dela || '').slice(0, 80));
  const km = wo.komada != null ? escHtml(String(wo.komada)) : '—';
  const mat = escHtml(String(wo.materijal || ''));
  return `
    <tr>
      <td style="text-align:center">
        <input type="checkbox" class="lp-tp-cb" data-lp-tp-cb="${escHtml(String(wo.id))}"${checkedAttr}
          title="Dodaj/ukloni iz reda za štampu" />
      </td>
      <td><strong>${idb}</strong></td>
      <td>${cr}</td>
      <td>${nz || '<span class="loc-muted">—</span>'}</td>
      <td class="loc-qty-cell">${km}</td>
      <td>${mat || '<span class="loc-muted">—</span>'}</td>
    </tr>`;
}

function refreshItemRowAppearance(host, itemId) {
  const tr = host.querySelector(`[data-lp-item-id="${itemId}"]`);
  if (!tr) return;
  const cb = tr.querySelector('[data-lp-item-cb]');
  if (cb instanceof HTMLInputElement) cb.checked = anyQueuedForItem(itemId);
}

/* ── Queue block (red za štampu) ──────────────────────────────────────── */

function renderQueueBlock(host, refresh) {
  const hostEl = host.querySelector('#lpQueueHost');
  if (!hostEl) return;
  const entries = Array.from(_state.queue.values());
  if (!entries.length) {
    hostEl.innerHTML = `<p class="loc-muted" style="padding:14px;border:1px dashed var(--border2,#ccc);border-radius:6px">
      Red je prazan. Čekiraj TP-ove u tabeli iznad da ih dodaš.
    </p>`;
    return;
  }
  const totalLabels = entries.reduce((s, e) => s + (Number(e.qty) || 0), 0);
  const rowsHtml = entries.map((e, idx) => renderQueueRowHtml(e, idx)).join('');
  hostEl.innerHTML = `
    <div class="loc-table-wrap" style="max-height:32vh;overflow:auto">
      <table class="loc-table">
        <thead>
          <tr>
            <th>Predmet</th>
            <th>RN (ident)</th>
            <th>Crtež</th>
            <th>Naziv dela</th>
            <th class="loc-qty-cell">Količina</th>
            <th style="width:60px"></th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
    <div style="display:flex;gap:10px;align-items:center;margin-top:10px;flex-wrap:wrap">
      <button type="button" class="btn btn-primary" id="lpQueuePrint"
        title="Pošalji ceo red u štampu (TSC ML340P) — biće odštampano ${totalLabels} fizičkih nalepnica.">
        🖨 Štampaj ${totalLabels} nalepnic${totalLabels === 1 ? 'u' : totalLabels < 5 ? 'e' : 'a'} (${entries.length} TP)
      </button>
      <button type="button" class="btn" id="lpQueueClear">Očisti red</button>
      <span class="loc-muted" style="font-size:12px">
        Red ostaje sačuvan dok prelaziš tab-ove, ali se briše pri logout-u i page reload-u.
      </span>
    </div>`;

  hostEl.querySelectorAll('[data-lp-qty]').forEach(inp => {
    inp.addEventListener('input', () => {
      const k = inp.getAttribute('data-lp-qty');
      const entry = _state.queue.get(k);
      if (!entry) return;
      const v = Math.max(1, Math.floor(Number(inp.value) || 1));
      entry.qty = v;
      /* Re-render samo footer (broj nalepnica) — ne celu tabelu da fokus
       * ostane u input-u. */
      const totalNow = Array.from(_state.queue.values()).reduce((s, e) => s + (Number(e.qty) || 0), 0);
      const btn = hostEl.querySelector('#lpQueuePrint');
      if (btn) {
        const cnt = _state.queue.size;
        btn.textContent = `🖨 Štampaj ${totalNow} nalepnic${totalNow === 1 ? 'u' : totalNow < 5 ? 'e' : 'a'} (${cnt} TP)`;
      }
    });
  });
  hostEl.querySelectorAll('[data-lp-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      const k = btn.getAttribute('data-lp-remove');
      _state.queue.delete(k);
      renderQueueBlock(host, refresh);
      /* Ažuriraj checkbox u TP listi i indikator u items tabeli. */
      renderTpsBlock(host, refresh);
      const itemId = Number((k || '').split(':')[0]);
      if (Number.isFinite(itemId)) refreshItemRowAppearance(host, itemId);
    });
  });
  hostEl.querySelector('#lpQueueClear')?.addEventListener('click', () => {
    if (!confirm(`Sigurno brišeš ceo red za štampu (${entries.length} stavk${entries.length === 1 ? 'a' : entries.length < 5 ? 'e' : 'i'})?`)) return;
    const itemIdsToRefresh = new Set(Array.from(_state.queue.keys()).map(k => Number(k.split(':')[0])));
    _state.queue.clear();
    renderQueueBlock(host, refresh);
    renderTpsBlock(host, refresh);
    itemIdsToRefresh.forEach(id => Number.isFinite(id) && refreshItemRowAppearance(host, id));
  });
  hostEl.querySelector('#lpQueuePrint')?.addEventListener('click', async () => {
    await runBatchPrint(host, refresh);
  });
}

function renderQueueRowHtml(entry, _idx) {
  const k = queueKey(entry.predmet.id, entry.tp.id);
  const pCode = escHtml(entry.predmet.broj_predmeta || '');
  const idb = escHtml(String(entry.tp.ident_broj || ''));
  const cr = escHtml(String(entry.tp.broj_crteza || '—'));
  const nz = escHtml(String(entry.tp.naziv_dela || '').slice(0, 60));
  const max = Number(entry.tp.komada) || 999;
  const qty = Math.max(1, Number(entry.qty) || 1);
  return `
    <tr>
      <td><strong>${pCode}</strong></td>
      <td>${idb}</td>
      <td>${cr}</td>
      <td>${nz || '<span class="loc-muted">—</span>'}</td>
      <td class="loc-qty-cell">
        <input type="number" class="loc-search-input" style="width:80px;padding:4px 8px"
          min="1" max="${max}" step="1" value="${qty}" inputmode="numeric"
          data-lp-qty="${escHtml(k)}" />
      </td>
      <td>
        <button type="button" class="btn btn-xs" data-lp-remove="${escHtml(k)}"
          title="Ukloni iz reda">✕</button>
      </td>
    </tr>`;
}

/* ── Batch print ──────────────────────────────────────────────────────── */

async function runBatchPrint(host, refresh) {
  const entries = Array.from(_state.queue.values());
  if (!entries.length) {
    showToast('⚠ Red je prazan');
    return;
  }
  const datum = todayStrDDMMYY();
  /* Pripremi specs za batch printer. Ako je iz nekog razloga RNZ encoder
   * vratio null (loš ident_broj), preskačemo taj red i prijavljujemo. */
  const specs = [];
  const skipped = [];
  for (const e of entries) {
    const idb = String(e.tp.ident_broj || '');
    const slash = idb.indexOf('/');
    const orderPart = slash >= 0 ? idb.slice(0, slash) : idb;
    const tpPart = slash >= 0 ? idb.slice(slash + 1) : '';
    const bc = formatBigTehnRnzBarcode({ orderNo: orderPart, tpNo: tpPart });
    if (!bc) {
      skipped.push(idb || `tp#${e.tp.id}`);
      continue;
    }
    const totalQty = Number(e.tp.komada) || e.qty;
    specs.push({
      barcodeValue: bc,
      copies: e.qty,
      fields: {
        brojPredmeta: idb,
        komitent: e.predmet.customer_name || '',
        nazivPredmeta: e.predmet.naziv_predmeta || '',
        nazivDela: e.tp.naziv_dela || '',
        brojCrteza: e.tp.broj_crteza || '',
        kolicina: `${e.qty}/${totalQty}`,
        materijal: e.tp.materijal || '',
        datum,
      },
    });
  }
  if (!specs.length) {
    showToast(`⚠ Ni jedan TP nije imao validan ident_broj. Preskočeno: ${skipped.length}`);
    return;
  }
  if (skipped.length) {
    if (!confirm(`Preskoče se ${skipped.length} TP-ova bez validnog ident_broja:\n${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? '…' : ''}\n\nNastavi sa ostalih ${specs.length}?`)) {
      return;
    }
  }
  await printTechProcessLabelsBatch(specs);
  /* Po default-u NE čistimo queue posle štampe — operater možda hoće da
   * ponovi otisak ili modifikuje pa ponovo štampa. Pruža eksplicitno
   * dugme „Očisti red" i poruku. */
  showToast(`Otisak poslat: ${specs.length} TP-ova, ukupno ${specs.reduce((s, x) => s + x.copies, 0)} nalepnica.`);
}

/* ── Cleanup za teardown modula ──────────────────────────────────────── */

/**
 * Briše ceo state — koristi se pri logout-u modula. Queue NE preživljava
 * page reload (jer state je in-memory), ali izlazak iz modula bi mogao
 * da je ostavi živom; eksplicitno ga čistimo radi konzistentnosti.
 */
export function resetLabelsPrintPageState() {
  _state.itemsRows = [];
  _state.focusedItemId = null;
  _state.tpsByItem.clear();
  _state.queue.clear();
  _state.lastSearch = '';
  _state.loading = false;
}
