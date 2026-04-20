/**
 * Servoteh Magacin — mobilni shell za LOKACIJE + PREMEŠTANJE.
 *
 * Minimalno što magacioner / viljuškarista vidi na telefonu:
 *   • jedno veliko dugme "📷 Skeniraj barkod"
 *   • drugo veliko dugme "⌨ Ručni unos crteža"
 *   • prečica "📋 Moja istorija"
 *   • prečica "🚪 Odjavi se"
 *
 * Nema sajdbara, modula, admin hub-a. Dizajn je za tap jednom rukom u
 * rukavicama — sve CTA dugmad imaju min-height 72px i ≥ 18px font.
 *
 * Renderuje se na ruti `/m` (vidi src/ui/router.js).
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { getAuth } from '../../state/auth.js';
import { logout } from '../../services/auth.js';
import { resetKadrovskaState } from '../../state/kadrovska.js';
import {
  countPendingMovements,
  listPendingMovements,
  flushPendingMovements,
} from '../../services/offlineQueue.js';
import { openScanMoveModal } from '../lokacije/scanModal.js';

const SHELL_ID = 'mobileShell';

/**
 * @param {HTMLElement} mountEl
 * @param {{
 *   onNavigate: (path: string) => void,
 *   onLogout: () => void,
 * }} ctx
 */
export function renderMobileHome(mountEl, ctx) {
  const auth = getAuth();
  const user = auth?.user;
  const email = user?.email || '—';
  const pending = countPendingMovements();

  const html = `
    <div class="m-shell" id="${SHELL_ID}">
      <header class="m-header">
        <div class="m-brand">
          <div class="m-brand-title">SERVOTEH MAGACIN</div>
          <div class="m-brand-sub">Lokacije i premeštanje</div>
        </div>
        <button type="button" class="m-btn-ghost" data-act="logout" aria-label="Odjavi se">⎋</button>
      </header>

      <div class="m-user-strip">
        <span class="m-user-email">${escHtml(email)}</span>
        ${
          pending > 0
            ? `<span class="m-badge m-badge-warn" data-act="flush" title="Klikni da pošalješ">⏳ ${pending} čeka</span>`
            : `<span class="m-badge m-badge-ok">✓ sinhronizovano</span>`
        }
      </div>

      <main class="m-main">
        <button type="button" class="m-cta m-cta-primary" data-act="scan">
          <span class="m-cta-ico">📷</span>
          <span class="m-cta-txt">
            <span class="m-cta-title">SKENIRAJ BARKOD</span>
            <span class="m-cta-sub">Uslikaj nalepnicu sa crtežom</span>
          </span>
        </button>

        <button type="button" class="m-cta m-cta-secondary" data-act="manual">
          <span class="m-cta-ico">⌨</span>
          <span class="m-cta-txt">
            <span class="m-cta-title">RUČNI UNOS</span>
            <span class="m-cta-sub">Unesi broj crteža ako nema barkoda</span>
          </span>
        </button>

        <div class="m-cta-row">
          <button type="button" class="m-cta m-cta-tertiary" data-act="history">
            <span class="m-cta-ico">📋</span>
            <span class="m-cta-title">MOJA ISTORIJA</span>
          </button>
          <button type="button" class="m-cta m-cta-tertiary" data-act="batch">
            <span class="m-cta-ico">🗂</span>
            <span class="m-cta-title">BATCH MOD</span>
          </button>
        </div>
      </main>

      <footer class="m-footer">
        <span>v.${__APP_VERSION__ || '1'}</span>
        <span class="m-dot">·</span>
        <span id="mNetIndicator">${navigator.onLine ? '🟢 online' : '🔴 offline'}</span>
      </footer>
    </div>
  `;

  mountEl.innerHTML = html;
  document.body.classList.add('m-body');

  const netEl = mountEl.querySelector('#mNetIndicator');
  const onOnline = () => {
    if (netEl) netEl.textContent = '🟢 online';
    /* Auto-flush queue kad se WiFi vrati. */
    void tryFlush(mountEl);
  };
  const onOffline = () => {
    if (netEl) netEl.textContent = '🔴 offline';
  };
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);

  mountEl.addEventListener('click', async ev => {
    const act = ev.target.closest('[data-act]')?.dataset?.act;
    if (!act) return;
    switch (act) {
      case 'scan':
        ctx.onNavigate('/m/scan');
        break;
      case 'manual':
        ctx.onNavigate('/m/manual');
        break;
      case 'history':
        ctx.onNavigate('/m/history');
        break;
      case 'batch':
        ctx.onNavigate('/m/batch');
        break;
      case 'flush':
        await tryFlush(mountEl);
        break;
      case 'logout':
        if (confirm('Da li stvarno želiš da se odjaviš?')) {
          try {
            await logout();
          } catch (e) {
            console.error('[mobile] logout failed', e);
          }
          resetKadrovskaState();
          ctx.onLogout();
        }
        break;
      default:
        break;
    }
  });

  return {
    teardown() {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.body.classList.remove('m-body');
      mountEl.innerHTML = '';
    },
  };
}

/**
 * Pokušaj da pošalješ sve što čeka u offline queue-u. Ako je online,
 * obradiće batch; ako nije, samo obavesti korisnika. Rerender header-a
 * da osveži badge.
 */
async function tryFlush(mountEl) {
  const pending = listPendingMovements();
  if (!pending.length) return;
  if (!navigator.onLine) {
    showToast('🔴 Trenutno offline — poslaće se kad se vrati signal');
    return;
  }
  showToast(`⏳ Šaljem ${pending.length} zapisa…`);
  const { ok, failed } = await flushPendingMovements();
  if (failed > 0) {
    showToast(`⚠ ${ok} poslano, ${failed} ostaje za kasnije`);
  } else {
    showToast(`✓ Poslano svih ${ok}`);
  }
  /* Minimalni rerender: samo ažuriraj badge bez full rerender-a. */
  const badge = mountEl.querySelector('.m-user-strip .m-badge');
  if (badge) {
    const remaining = countPendingMovements();
    if (remaining > 0) {
      badge.className = 'm-badge m-badge-warn';
      badge.textContent = `⏳ ${remaining} čeka`;
    } else {
      badge.className = 'm-badge m-badge-ok';
      badge.textContent = '✓ sinhronizovano';
    }
  }
}

/* ── Ostali "stage" ekrani mobilnog shell-a ─────────────────────────────── */

/**
 * Otvori scan modal odmah — ovo je isto što se dešava kada user na desktopu
 * klikne "Skeniraj". Razlika je što po zatvaranju vraćamo na `/m`.
 */
export function renderMobileScan(mountEl, ctx) {
  /* Sami rendererI scan-a su full-screen overlay-i (uzimaju viewport).
   * Ispod njih držimo praznu podlogu tipa loading — da se ne blica hub. */
  mountEl.innerHTML = `<div class="m-shell m-shell-loading"><div class="m-loading-dot"></div></div>`;
  document.body.classList.add('m-body');

  const goHome = () => ctx.onNavigate('/m');

  openScanMoveModal({
    startMode: 'scan',
    onSuccess: () => {
      /* Nakon uspešnog premeštanja → back na home (i pending queue badge osvežen). */
      goHome();
    },
    onClose: goHome,
  });

  return {
    teardown() {
      document.body.classList.remove('m-body');
      mountEl.innerHTML = '';
    },
  };
}

/**
 * Isto što i renderMobileScan ali otvara formu u "manual" modu —
 * kamera se ne traži, radnik odmah vidi polja Broj naloga / Broj crteža.
 */
export function renderMobileManual(mountEl, ctx) {
  mountEl.innerHTML = `<div class="m-shell m-shell-loading"><div class="m-loading-dot"></div></div>`;
  document.body.classList.add('m-body');

  const goHome = () => ctx.onNavigate('/m');

  openScanMoveModal({
    startMode: 'manual',
    onSuccess: () => {
      goHome();
    },
    onClose: goHome,
  });

  return {
    teardown() {
      document.body.classList.remove('m-body');
      mountEl.innerHTML = '';
    },
  };
}
