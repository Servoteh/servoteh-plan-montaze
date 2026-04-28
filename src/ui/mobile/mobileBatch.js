/**
 * Mobilni "Batch mod" — radnik skenira N nalepnica zaredom (npr. 20 komada
 * iz iste palete), pa jednim klikom "Pošalji sve" upisujemo sve u Supabase.
 *
 * Workflow:
 *   1. Korisnik prvo izabere ODREDIŠNU lokaciju (gde ide sve što skenira).
 *   2. Pritisne "Start" → otvara se kamera.
 *   3. Svaki skeniranje = jedan red u lokalnoj listi sa malim +/- qty kontrolama.
 *   4. "Obriši skeniranje" po redu ako je greškom.
 *   5. "Pošalji sve" → sekvencijalno (ne paralelno, da ne udvostruči nalog)
 *      RPC loc_create_movement. Ako je offline, gura u offlineQueue.
 *
 * Pojednostavljenja:
 *   • Svi redovi idu na ISTU `to_location_id` (najčešći scenario: "sve na
 *     policu K-A3"). Različite destinacije → Single-shot mod (scanModal).
 *   • `from_location_id` se ne pita eksplicitno — ostavljamo serveru da
 *     auto-pogodi (`from_ambiguous` šalje grešku → rešavamo manuelno kasnije).
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { fetchLocations, locCreateMovement } from '../../services/lokacije.js';
import { enqueueMovement } from '../../services/offlineQueue.js';

let _barcodeModPromise = null;
function loadBarcodeModule() {
  if (!_barcodeModPromise) {
    _barcodeModPromise = import('../../services/barcode.js');
  }
  return _barcodeModPromise;
}

/**
 * @param {HTMLElement} mountEl
 * @param {{ onNavigate: (path: string) => void }} ctx
 */
export async function renderMobileBatch(mountEl, ctx) {
  document.body.classList.add('m-body');

  const locs = await fetchLocations();
  const activeLocs = (locs || []).filter(l => l.is_active !== false);
  const locOptions =
    '<option value="">— izaberi odredište —</option>' +
    activeLocs
      .map(l => `<option value="${escHtml(l.id)}">${escHtml(l.location_code)} — ${escHtml(l.name)}</option>`)
      .join('');

  mountEl.innerHTML = `
    <div class="m-shell">
      <header class="m-header">
        <button type="button" class="m-btn-ghost" data-act="back" aria-label="Nazad">←</button>
        <div class="m-brand">
          <div class="m-brand-title">BATCH SKENIRANJE</div>
          <div class="m-brand-sub">više komada u istu lokaciju</div>
        </div>
        <button type="button" class="m-btn-ghost" data-act="reset" aria-label="Resetuj listu">🗑</button>
      </header>

      <main class="m-main m-batch-main">
        <div class="m-batch-setup">
          <label class="m-field-label" for="mBatchTo">Sve ide u lokaciju</label>
          <select id="mBatchTo" class="m-select">${locOptions}</select>
        </div>

        <div class="m-batch-video-wrap" hidden id="mBatchVideoWrap">
          <video class="m-batch-video" id="mBatchVideo" playsinline autoplay muted></video>
          <div class="loc-scan-reticle" aria-hidden="true"></div>
          <div class="loc-scan-laser" aria-hidden="true"></div>
          <button type="button" class="m-batch-torch" data-act="torch">💡</button>
          <button type="button" class="m-batch-stop" data-act="stop">PAUZIRAJ</button>
          <div class="m-batch-hint" id="mBatchHint">Usmeri na nalepnicu…</div>
        </div>

        <div class="m-batch-list" id="mBatchList"></div>

        <div class="m-batch-footer">
          <button type="button" class="m-cta m-cta-primary" data-act="start" id="mBatchStart">
            📷 POČNI SKENIRANJE
          </button>
          <button type="button" class="m-cta m-cta-secondary" data-act="submit" id="mBatchSubmit" hidden>
            ✓ POŠALJI SVE (0)
          </button>
        </div>

        <div class="m-batch-err" id="mBatchErr"></div>
      </main>
    </div>
  `;

  /** @typedef {{ id: string, itemRefId: string, orderNo: string, qty: number, raw: string }} BatchRow */
  /** @type {BatchRow[]} */
  const rows = [];
  /** @type {{ scanCtrl: any }} */
  const state = { scanCtrl: null };

  const $ = sel => mountEl.querySelector(sel);
  const listEl = $('#mBatchList');
  const submitBtn = $('#mBatchSubmit');
  const startBtn = $('#mBatchStart');
  const videoWrap = $('#mBatchVideoWrap');
  const videoEl = $('#mBatchVideo');
  const hintEl = $('#mBatchHint');
  const errEl = $('#mBatchErr');
  const toSel = $('#mBatchTo');

  if (/Android/i.test(navigator.userAgent || '')) {
    mountEl.querySelector('.m-batch-torch')?.setAttribute('hidden', '');
  }

  function refreshList() {
    if (!rows.length) {
      listEl.innerHTML = `<div class="m-empty-small">Nijedna nalepnica skenirana.</div>`;
      submitBtn.hidden = true;
      return;
    }
    const totalQty = rows.reduce((a, r) => a + r.qty, 0);
    listEl.innerHTML = rows
      .map(
        (r, idx) => `
      <div class="m-batch-row" data-row-id="${escHtml(r.id)}">
        <div class="m-batch-row-head">
          <span class="m-batch-row-idx">#${idx + 1}</span>
          <span class="m-batch-row-drawing">📐 ${escHtml(r.itemRefId)}</span>
          ${r.orderNo ? `<span class="m-batch-row-order">nalog ${escHtml(r.orderNo)}</span>` : ''}
          <button type="button" class="m-batch-row-del" data-act="del-row" data-row-id="${escHtml(r.id)}" aria-label="Obriši">✕</button>
        </div>
        <div class="m-batch-row-qty">
          <button type="button" class="m-qty-btn" data-act="qty-dec" data-row-id="${escHtml(r.id)}">−</button>
          <span class="m-qty-value">${r.qty}</span>
          <button type="button" class="m-qty-btn" data-act="qty-inc" data-row-id="${escHtml(r.id)}">+</button>
          <span class="m-qty-unit">kom</span>
        </div>
      </div>`,
      )
      .join('');

    submitBtn.hidden = false;
    submitBtn.textContent = `✓ POŠALJI SVE (${rows.length} · ${totalQty} kom)`;
  }

  function genId() {
    return (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).toUpperCase();
  }

  function addScan(parsed) {
    const itemRefId = parsed?.drawingNo || (typeof parsed === 'string' ? parsed : '');
    const orderNo = parsed?.orderNo || '';
    if (!itemRefId) {
      hintEl.textContent = '⚠ Neprepoznat kod — preskačem';
      if (navigator.vibrate) navigator.vibrate([80, 40, 80]);
      return;
    }
    /* Ako je isti (crtež, nalog) već skeniran u batch-u → samo povećaj qty.
     * Radnik će tako moći lakše: skenirao jednom iste stvari = +1 automatski. */
    const existing = rows.find(r => r.itemRefId === itemRefId && r.orderNo === orderNo);
    if (existing) {
      existing.qty += 1;
      hintEl.textContent = `+1 ${itemRefId} (ukupno ${existing.qty})`;
    } else {
      rows.push({
        id: genId(),
        itemRefId,
        orderNo,
        qty: 1,
        raw: parsed?.raw || itemRefId,
      });
      hintEl.textContent = `✓ ${itemRefId}${orderNo ? ' · nalog ' + orderNo : ''}`;
    }
    if (navigator.vibrate) navigator.vibrate(60);
    refreshList();
  }

  async function startScanner() {
    if (!toSel.value) {
      showToast('⚠ Prvo izaberi odredišnu lokaciju');
      return;
    }
    errEl.textContent = '';
    videoWrap.hidden = false;
    startBtn.hidden = true;
    hintEl.textContent = 'Usmeri na nalepnicu…';

    try {
      const barcodeMod = await loadBarcodeModule();
      const { normalizeBarcodeText, parseBigTehnBarcode, startScan } = barcodeMod;

      state.scanCtrl = await startScan(videoEl, {
        onResult: text => {
          const clean = normalizeBarcodeText(text);
          if (!clean) return;
          const parsed = parseBigTehnBarcode(clean) || clean;
          addScan(parsed);
          /* Ne stopiramo skener — ostavimo ga da i dalje skenira, samo
           * debounce-ujemo isti kod 1.5s da ne dupliramo. */
        },
        onError: err => console.error('[batch-scan] error', err),
      });
    } catch (err) {
      errEl.textContent = `Kamera: ${err.message || err}`;
      videoWrap.hidden = true;
      startBtn.hidden = false;
    }
  }

  function stopScanner() {
    if (state.scanCtrl) {
      state.scanCtrl.stop();
      state.scanCtrl = null;
    }
    videoWrap.hidden = true;
    startBtn.hidden = false;
    startBtn.textContent = rows.length > 0 ? '📷 NASTAVI SKENIRANJE' : '📷 POČNI SKENIRANJE';
  }

  async function submitAll() {
    if (!rows.length) return;
    const toId = toSel.value;
    if (!toId) {
      errEl.textContent = 'Odredišna lokacija je obavezna.';
      return;
    }

    stopScanner();
    submitBtn.disabled = true;
    submitBtn.textContent = `⏳ Šaljem 1/${rows.length}…`;

    let ok = 0;
    let queued = 0;
    let failed = 0;
    const errs = [];

    /* Sekvencijalno, da server-side already_placed/from_ambiguous logika
     * vidi prethodne insert-e pre sledećeg. Paralelno bi moglo da u sred
     * batch-a sruši jedan od njih. */
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      submitBtn.textContent = `⏳ Šaljem ${i + 1}/${rows.length}…`;
      const payload = {
        item_ref_table: 'bigtehn_rn',
        item_ref_id: r.itemRefId,
        order_no: r.orderNo || '',
        to_location_id: toId,
        movement_type: 'INITIAL_PLACEMENT',
        quantity: r.qty,
        note: `Batch (${rows.length} total)`,
      };

      if (!navigator.onLine) {
        enqueueMovement(payload);
        queued += 1;
        continue;
      }

      try {
        const res = await locCreateMovement(payload);
        if (res?.ok) {
          ok += 1;
        } else if (res?.error === 'already_placed') {
          /* Pokušaj kao TRANSFER bez from_id (server će probati auto-detect). */
          const tr = await locCreateMovement({
            ...payload,
            movement_type: 'TRANSFER',
          });
          if (tr?.ok) {
            ok += 1;
          } else {
            failed += 1;
            errs.push(`${r.itemRefId} (${r.orderNo || '-'}): ${tr?.error || 'fail'}`);
          }
        } else {
          failed += 1;
          errs.push(`${r.itemRefId} (${r.orderNo || '-'}): ${res?.error || 'fail'}`);
        }
      } catch (e) {
        /* Network pad u sred batch-a — ostatak queue-uj. */
        enqueueMovement(payload);
        queued += 1;
      }
    }

    submitBtn.disabled = false;

    const lines = [`✓ Poslano: ${ok}`];
    if (queued) lines.push(`⏳ Queue: ${queued}`);
    if (failed) lines.push(`⚠ Greške: ${failed}`);
    showToast(lines.join(' · '));

    if (errs.length) {
      errEl.innerHTML = `
        <strong>Problemi:</strong><br>
        ${errs.map(e => escHtml(e)).join('<br>')}
      `;
    }

    if (failed === 0) {
      /* Clean state — vrati na home posle kratke pauze da user vidi toast. */
      setTimeout(() => ctx.onNavigate('/m'), 1200);
    } else {
      /* Ostavi user-a na ekranu da prepravi problematične. */
      refreshList();
    }
  }

  /* Event wiring */
  mountEl.addEventListener('click', async ev => {
    const target = ev.target.closest('[data-act]');
    const act = target?.dataset?.act;
    const rowId = target?.dataset?.rowId;
    if (!act) return;
    switch (act) {
      case 'back':
        stopScanner();
        ctx.onNavigate('/m');
        break;
      case 'reset':
        if (rows.length && !confirm('Izbrisati sve skenirane redove?')) return;
        rows.length = 0;
        refreshList();
        break;
      case 'start':
        await startScanner();
        break;
      case 'stop':
        stopScanner();
        break;
      case 'torch':
        if (state.scanCtrl) {
          const on = await state.scanCtrl.toggleTorch();
          target.style.opacity = on ? '1' : '0.5';
        }
        break;
      case 'submit':
        await submitAll();
        break;
      case 'del-row':
        if (!rowId) return;
        {
          const idx = rows.findIndex(r => r.id === rowId);
          if (idx >= 0) rows.splice(idx, 1);
          refreshList();
        }
        break;
      case 'qty-inc':
        if (!rowId) return;
        {
          const r = rows.find(x => x.id === rowId);
          if (r) {
            r.qty += 1;
            refreshList();
          }
        }
        break;
      case 'qty-dec':
        if (!rowId) return;
        {
          const r = rows.find(x => x.id === rowId);
          if (r && r.qty > 1) {
            r.qty -= 1;
            refreshList();
          }
        }
        break;
      default:
        break;
    }
  });

  refreshList();

  return {
    teardown() {
      stopScanner();
      document.body.classList.remove('m-body');
      mountEl.innerHTML = '';
    },
  };
}
