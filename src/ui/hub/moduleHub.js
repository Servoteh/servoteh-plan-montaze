/**
 * Module hub — landing screen posle login-a.
 *
 * Kartice (sa istim renames-ima koje je user tražio u prethodnoj sesiji):
 *   - Plan Montaže          [aktivno]
 *   - Lokacije delova       [u pripremi]
 *   - Održavanje mašina     [u pripremi]
 *   - Sastanci              [u pripremi]
 *   - Planiranje proizvodnje [u pripremi]
 *   - Kadrovska             [aktivno za hr/admin]
 *   - Podešavanja           [aktivno samo za admin]
 *
 * Logika vidljivosti:
 *   - Kadrovska je vidljiva svima ali "u pripremi" za role bez canAccessKadrovska
 *     (u legacy-ju je kartica vidljiva svima — toast-ova kontrola pristupa).
 *   - Podešavanja je SAKRIVENA za ne-admin korisnike (data-hidden).
 *
 * onModuleSelect(moduleId): callback koji aktivira modul (Plan Montaže ili
 * Kadrovska placeholder; ostali kartice prikazuju samo toast).
 */

import { showToast, escHtml } from '../../lib/dom.js';
import { toggleTheme } from '../../lib/theme.js';
import { logout } from '../../services/auth.js';
import { getAuth, canManageUsers, canAccessKadrovska } from '../../state/auth.js';

const PLACEHOLDER_TOAST = {
  'lokacije-delova': '📍 Lokacije delova — u pripremi',
  'odrzavanje-masina': '🛠 Održavanje mašina — u pripremi',
  'sastanci': '📅 Sastanci — u pripremi',
  'planiranje-proizvodnje': '🏭 Planiranje proizvodnje — u pripremi',
};

export function renderModuleHub({ onModuleSelect, onLogout }) {
  const auth = getAuth();
  const settingsHidden = !canManageUsers();

  const container = document.createElement('div');
  container.className = 'module-hub';
  container.id = 'moduleHub';
  container.innerHTML = `
    <header class="hub-header">
      <div class="hub-brand">
        <div class="hub-brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.8-.7-.7-2.8 2.5-2.5z"></path></svg>
        </div>
        <div class="hub-brand-text">
          <span class="hub-brand-title">Servoteh</span>
          <span class="hub-brand-sub">Interni sistem</span>
        </div>
      </div>
      <div class="hub-header-right">
        <button class="theme-toggle" id="hubThemeToggle" title="Promeni temu" aria-label="Promeni temu">
          <span class="theme-icon-dark">🌙</span>
          <span class="theme-icon-light">☀️</span>
        </button>
        <div class="hub-user">
          <span class="hub-user-email" id="hubUserEmail">${escHtml(auth.user?.email || '—')}</span>
          <span class="hub-user-role" id="hubUserRole">${escHtml(auth.role)}</span>
        </div>
        <button class="hub-logout" id="hubLogoutBtn">Odjavi se</button>
      </div>
    </header>

    <main class="hub-main">
      <div class="hub-intro">
        <h2>Dobrodošli nazad</h2>
        <p>Izaberi modul sa kojim želiš da radiš. Aktivni moduli: <strong style="color:var(--text)">Plan Montaže</strong> i <strong style="color:var(--text)">Kadrovska</strong>${canManageUsers() ? ' i <strong style="color:var(--text)">Podešavanja</strong>' : ''}.</p>
      </div>

      <div class="hub-grid">
        <button type="button" class="hub-card" data-module="plan-montaze" aria-label="Otvori Plan Montaže">
          <div class="hub-card-icon" aria-hidden="true">🛠</div>
          <div class="hub-card-title">Plan Montaže</div>
          <div class="hub-card-desc">Planiraj i prati faze montaže po projektima i pozicijama. Gantogram, spremnost, odgovorni, rizici, export u PDF/Excel.</div>
          <div class="hub-card-footer">
            <span class="hub-card-cta">Otvori →</span>
            <span class="hub-card-badge badge-active">Aktivno</span>
          </div>
        </button>

        <button type="button" class="hub-card is-disabled" data-toast="lokacije-delova" aria-disabled="true">
          <div class="hub-card-icon" aria-hidden="true">📍</div>
          <div class="hub-card-title">Lokacije delova</div>
          <div class="hub-card-desc">Evidencija gde se fizički nalaze delovi, sklopovi i alati: regal, polica, magacin, projektna lokacija. Brza pretraga i premeštanje.</div>
          <div class="hub-card-footer">
            <span class="hub-card-cta">Uskoro</span>
            <span class="hub-card-badge">U pripremi</span>
          </div>
        </button>

        <button type="button" class="hub-card is-disabled" data-toast="odrzavanje-masina" aria-disabled="true">
          <div class="hub-card-icon" aria-hidden="true">🛠</div>
          <div class="hub-card-title">Održavanje mašina</div>
          <div class="hub-card-desc">Plan i evidencija preventivnog i korektivnog održavanja: intervalni servisi, kvarovi, utrošeni delovi, sati zastoja po mašini.</div>
          <div class="hub-card-footer">
            <span class="hub-card-cta">Uskoro</span>
            <span class="hub-card-badge">U pripremi</span>
          </div>
        </button>

        <button type="button" class="hub-card is-disabled" data-toast="sastanci" aria-disabled="true">
          <div class="hub-card-icon" aria-hidden="true">📅</div>
          <div class="hub-card-title">Sastanci</div>
          <div class="hub-card-desc">Zakazivanje, dnevni red, učesnici i zapisnici sastanaka. Akcioni zaključci sa rokovima i odgovornima, pretraga starih sastanaka.</div>
          <div class="hub-card-footer">
            <span class="hub-card-cta">Uskoro</span>
            <span class="hub-card-badge">U pripremi</span>
          </div>
        </button>

        <button type="button" class="hub-card is-disabled" data-toast="planiranje-proizvodnje" aria-disabled="true">
          <div class="hub-card-icon" aria-hidden="true">🏭</div>
          <div class="hub-card-title">Planiranje proizvodnje</div>
          <div class="hub-card-desc">Plan opterećenja mašina i operatera, redosled radnih naloga, kapaciteti po smeni i pregled uskih grla. Sinhronizacija sa Plan Montaže.</div>
          <div class="hub-card-footer">
            <span class="hub-card-cta">Uskoro</span>
            <span class="hub-card-badge">U pripremi</span>
          </div>
        </button>

        <button type="button" class="hub-card${canAccessKadrovska() ? '' : ' is-disabled'}" data-module="kadrovska" aria-label="Otvori Kadrovsku"${canAccessKadrovska() ? '' : ' aria-disabled="true"'}>
          <div class="hub-card-icon" aria-hidden="true">👥</div>
          <div class="hub-card-title">Kadrovska</div>
          <div class="hub-card-desc">Evidencija zaposlenih, odsustva, sati rada, ugovori i mesečni grid. Pristup imaju HR i admin.</div>
          <div class="hub-card-footer">
            <span class="hub-card-cta">${canAccessKadrovska() ? 'Otvori →' : 'Pristup samo HR/admin'}</span>
            <span class="hub-card-badge ${canAccessKadrovska() ? 'badge-active' : ''}">${canAccessKadrovska() ? 'Aktivno' : 'Zaključano'}</span>
          </div>
        </button>

        <button type="button" class="hub-card requires-admin" id="hubCardSettings" data-module="podesavanja" aria-label="Otvori Podešavanja"${settingsHidden ? ' style="display:none"' : ''}>
          <div class="hub-card-icon" aria-hidden="true">⚙</div>
          <div class="hub-card-title">Podešavanja</div>
          <div class="hub-card-desc">Korisnici, uloge, matični podaci i integracije sa ostalim Servoteh sistemima.</div>
          <div class="hub-card-footer">
            <span class="hub-card-cta">Otvori →</span>
            <span class="hub-card-badge badge-active">Aktivno</span>
          </div>
        </button>
      </div>
    </main>

    <footer class="hub-footer"><strong>SERVOTEH</strong> · Interni sistem · v5.1 · <span style="opacity:.6">Vite migration build</span></footer>
  `;

  /* Wire događaji */
  container.querySelector('#hubThemeToggle').addEventListener('click', toggleTheme);
  container.querySelector('#hubLogoutBtn').addEventListener('click', async () => {
    await logout();
    onLogout?.();
  });

  container.querySelectorAll('button[data-module]').forEach(btn => {
    btn.addEventListener('click', () => {
      const moduleId = btn.dataset.module;
      if (moduleId === 'kadrovska' && !canAccessKadrovska()) {
        showToast('🔒 Kadrovska je dostupna samo HR/admin korisnicima');
        return;
      }
      onModuleSelect?.(moduleId);
    });
  });

  container.querySelectorAll('button[data-toast]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.toast;
      showToast(PLACEHOLDER_TOAST[key] || 'U pripremi');
    });
  });

  return container;
}
