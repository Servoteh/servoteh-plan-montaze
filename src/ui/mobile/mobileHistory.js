/**
 * Mobilni ekran "Moja istorija" — prikazuje poslednjih 50 premeštanja koje
 * je upravo ovaj korisnik zabeležio. Optimizovano za brz tap-pretraga-scroll
 * workflow u halama (nije analitika — tu postoji istorija modula na desktopu).
 *
 * Svako premestanje je kartica:
 *   ┌──────────────────────────────────────┐
 *   │  📐 1091063  ·  nalog 9000           │
 *   │  MAG › K-A1  ·  5 kom                │
 *   │  pre 4 min                           │
 *   └──────────────────────────────────────┘
 */

import { escHtml } from '../../lib/dom.js';
import { fetchMovementsHistory, fetchLocations } from '../../services/lokacije.js';
import { getAuth } from '../../state/auth.js';

/** Human-readable razlika od sada (sr). */
function fmtAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  const now = Date.now();
  const sec = Math.max(0, Math.floor((now - then) / 1000));
  if (sec < 60) return `pre ${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `pre ${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `pre ${hr}h`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `pre ${d}d`;
  /* Stara zabeleška — prikaži datum. */
  return new Date(iso).toLocaleDateString('sr-RS');
}

/**
 * @param {HTMLElement} mountEl
 * @param {{ onNavigate: (path: string) => void }} ctx
 */
export async function renderMobileHistory(mountEl, ctx) {
  document.body.classList.add('m-body');
  mountEl.innerHTML = `
    <div class="m-shell">
      <header class="m-header">
        <button type="button" class="m-btn-ghost" data-act="back" aria-label="Nazad">←</button>
        <div class="m-brand">
          <div class="m-brand-title">MOJA ISTORIJA</div>
          <div class="m-brand-sub">poslednjih 50 premeštanja</div>
        </div>
        <button type="button" class="m-btn-ghost" data-act="reload" aria-label="Osveži">⟳</button>
      </header>

      <main class="m-main m-history-main">
        <div id="mHistList" class="m-history-list">
          <div class="m-loading-dot"></div>
        </div>
      </main>
    </div>
  `;

  const listEl = mountEl.querySelector('#mHistList');
  const goBack = () => ctx.onNavigate('/m');

  mountEl.addEventListener('click', ev => {
    const act = ev.target.closest('[data-act]')?.dataset?.act;
    if (act === 'back') goBack();
    else if (act === 'reload') void loadData();
  });

  async function loadData() {
    const auth = getAuth();
    const uid = auth?.user?.id;
    if (!uid) {
      listEl.innerHTML = `<div class="m-empty">⚠ Nisi prijavljen.</div>`;
      return;
    }

    listEl.innerHTML = `<div class="m-loading-dot"></div>`;

    /* Povlačimo paralelno: moje poslednje 50 + mapu lokacija za prikaz kodova.
     * Lokacije cache-ujemo u localStorage-u (TTL 10 min) da ovo bude instant
     * na drugoj poseti — u magacinu retko menjamo definiciju lokacija. */
    const [rows, locs] = await Promise.all([
      fetchMovementsHistory({ userId: uid, limit: 50, offset: 0 }),
      fetchLocationsCached(),
    ]);

    if (!Array.isArray(rows) || rows.length === 0) {
      listEl.innerHTML = `
        <div class="m-empty">
          <div class="m-empty-ico">📋</div>
          <div class="m-empty-title">Još nema zabeleženih premeštanja</div>
          <div class="m-empty-sub">Kad skeniraš ili ručno uneseš prvi crtež, pojaviće se ovde.</div>
        </div>
      `;
      return;
    }

    const locMap = new Map((locs || []).map(l => [l.id, l]));
    listEl.innerHTML = rows.map(r => renderCard(r, locMap)).join('');
  }

  function renderCard(r, locMap) {
    const fromLoc = locMap.get(r.from_location_id);
    const toLoc = locMap.get(r.to_location_id);
    const fromLbl = fromLoc ? fromLoc.location_code : '—';
    const toLbl = toLoc ? toLoc.location_code : '—';
    const orderChip = r.order_no
      ? `<span class="m-hist-order">nalog ${escHtml(r.order_no)}</span>`
      : '';
    const typeLbl = humanizeType(r.movement_type);
    return `
      <div class="m-hist-card">
        <div class="m-hist-head">
          <span class="m-hist-drawing">📐 ${escHtml(r.item_ref_id)}</span>
          ${orderChip}
        </div>
        <div class="m-hist-move">
          <span class="m-hist-from">${escHtml(fromLbl)}</span>
          <span class="m-hist-arrow">›</span>
          <span class="m-hist-to">${escHtml(toLbl)}</span>
          <span class="m-hist-qty">${escHtml(String(r.quantity || 1))} kom</span>
        </div>
        <div class="m-hist-meta">
          <span>${escHtml(typeLbl)}</span>
          <span class="m-dot">·</span>
          <span>${escHtml(fmtAgo(r.moved_at))}</span>
        </div>
      </div>
    `;
  }

  await loadData();

  return {
    teardown() {
      document.body.classList.remove('m-body');
      mountEl.innerHTML = '';
    },
  };
}

function humanizeType(t) {
  switch (t) {
    case 'INITIAL_PLACEMENT':
      return 'prvi unos';
    case 'TRANSFER':
      return 'premeštanje';
    case 'INVENTORY_ADJUSTMENT':
      return 'korekcija';
    case 'SEND_TO_SERVICE':
      return 'servis';
    case 'SEND_TO_FIELD':
      return 'teren';
    case 'RETURN_FROM_SERVICE':
      return 'povratak (servis)';
    case 'RETURN_FROM_FIELD':
      return 'povratak (teren)';
    case 'SCRAP':
      return 'otpis';
    default:
      return t || '—';
  }
}

/* ── Lokacije cache (lokalni, 10 min TTL) ───────────────────────────────── */

const LOC_CACHE_KEY = 'm.locations.cache.v1';
const LOC_CACHE_TTL_MS = 10 * 60 * 1000;

async function fetchLocationsCached() {
  try {
    const raw = localStorage.getItem(LOC_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.ts && Date.now() - parsed.ts < LOC_CACHE_TTL_MS && Array.isArray(parsed.rows)) {
        return parsed.rows;
      }
    }
  } catch (e) {
    /* corrupted — ignoriši, opet ćemo fetch-ovati. */
  }
  const rows = await fetchLocations();
  try {
    localStorage.setItem(LOC_CACHE_KEY, JSON.stringify({ ts: Date.now(), rows }));
  } catch (e) {
    /* quota — ignoriši */
  }
  return rows;
}
