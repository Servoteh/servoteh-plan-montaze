/**
 * Login overlay — bit-paritet sa legacy/index.html .auth-overlay.
 *
 * Prima:
 *   onLoginSuccess() — callback koji se okida kad login (ili offline mode) prođe
 *
 * Koristi:
 *   - login() iz services/auth.js
 *   - showToast() za feedback
 *   - Bez inline onclick-ova — sve preko addEventListener.
 */

import { login } from '../../services/auth.js';
import { setUser, setOnline, setRole } from '../../state/auth.js';
import { escHtml, showToast } from '../../lib/dom.js';
import { hasSupabaseConfig } from '../../lib/constants.js';

export function renderLoginScreen({ onLoginSuccess }) {
  const overlay = document.createElement('div');
  overlay.className = 'auth-overlay';
  overlay.id = 'authOverlay';
  overlay.innerHTML = `
    <div class="auth-box" role="dialog" aria-labelledby="authTitle" aria-describedby="authSubtitle">
      <div class="auth-brand">
        <div class="auth-brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" role="img" aria-label="Servoteh">
            <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.8-.7-.7-2.8 2.5-2.5z"></path>
          </svg>
        </div>
        <div class="auth-title" id="authTitle">Plan Montaže</div>
        <div class="auth-subtitle" id="authSubtitle">Servoteh · Sistem za planiranje montaža</div>
      </div>

      <form class="auth-form" id="authForm">
        <div class="auth-field">
          <label for="loginEmail">Email</label>
          <input type="email" id="loginEmail" placeholder="ime@servoteh.rs" autocomplete="username" required>
        </div>
        <div class="auth-field">
          <label for="loginPassword">Lozinka</label>
          <input type="password" id="loginPassword" placeholder="••••••••" autocomplete="current-password" required>
        </div>
        <button type="submit" class="auth-btn-primary" id="authSubmitBtn">
          Prijavi se
          <span class="arrow" aria-hidden="true">→</span>
        </button>
      </form>

      <div class="auth-divider">ili</div>

      <button type="button" class="auth-btn-ghost" id="authOfflineBtn">Nastavi offline</button>

      <div class="auth-msg" id="authMsg" role="status" aria-live="polite"></div>

      <div class="auth-footer"><strong>SERVOTEH</strong> · Plan Montaže</div>
    </div>
  `;

  /* Wire događaji */
  const form = overlay.querySelector('#authForm');
  const offlineBtn = overlay.querySelector('#authOfflineBtn');
  const msg = overlay.querySelector('#authMsg');
  const submitBtn = overlay.querySelector('#authSubmitBtn');

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const email = overlay.querySelector('#loginEmail').value;
    const pass = overlay.querySelector('#loginPassword').value;

    if (!hasSupabaseConfig()) {
      msg.innerHTML = '<span class="auth-err">Supabase konfiguracija nije postavljena</span>';
      return;
    }

    msg.textContent = 'Prijavljivanje...';
    submitBtn.disabled = true;
    try {
      const res = await login(email, pass);
      if (!res.ok) {
        msg.innerHTML = '<span class="auth-err">' + escHtml(res.error) + '</span>';
        submitBtn.disabled = false;
        return;
      }
      msg.textContent = '';
      onLoginSuccess?.({ offline: false });
    } catch (e) {
      console.error('[loginScreen] error', e);
      msg.innerHTML = '<span class="auth-err">Greška pri prijavi</span>';
      submitBtn.disabled = false;
    }
  });

  offlineBtn.addEventListener('click', () => {
    /* Offline mode: nema Supabase pristupa, ali aplikacija radi sa local cache-em */
    setUser({ email: 'offline@local', emailRaw: 'offline@local', id: 'local', _token: null });
    setOnline(false);
    setRole('pm');
    showToast('💾 Offline režim — localStorage');
    onLoginSuccess?.({ offline: true });
  });

  return overlay;
}
