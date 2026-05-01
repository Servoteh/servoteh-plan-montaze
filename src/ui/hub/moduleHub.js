/**
 * Module hub — landing screen posle login-a.
 *
 * Kartice (sa istim renames-ima koje je user tražio u prethodnoj sesiji):
 *   - Plan Montaže          [aktivno]
 *   - Lokacije delova       [aktivno — skelet + loc_* migracija]
 *   - Održavanje mašina     [skelet + URL deep link; baza sledeća faza]
 *   - Sastanci              [u pripremi]
 *   - Planiranje proizvodnje [aktivno — Sprint F]
 *   - Kadrovska             [aktivno za hr/admin]
 *   - Podešavanja           [admin: svi tabovi; menadžment: održ. profili]
 *
 * Logika vidljivosti:
 *   - Kadrovska je vidljiva svima ali "u pripremi" za role bez canAccessKadrovska
 *     (u legacy-ju je kartica vidljiva svima — toast-ova kontrola pristupa).
 *   - Plan Proizvodnje je aktivna za sve authenticated; pm/admin pišu, ostali read-only.
 *   - Podešavanja je sakrivena za korisnike koji nisu admin ni menadžment.
 *
 * onModuleSelect(moduleId): callback koji aktivira modul (Plan Montaže,
 * Plan Proizvodnje, Kadrovska, Podešavanja).
 */

import { APP_PRODUCT_NAME } from '../../lib/constants.js';
import { showToast, escHtml } from '../../lib/dom.js';
import { toggleTheme } from '../../lib/theme.js';
import { logout } from '../../services/auth.js';
import {
  getAuth,
  canAccessPodesavanja,
  canAccessKadrovska,
  canEditPlanProizvodnje,
  canAccessSastanci,
  canEditSastanci,
  canAccessLokacije,
} from '../../state/auth.js';

export function renderModuleHub({ onModuleSelect, onLogout }) {
  const auth = getAuth();
  const settingsHidden = !canAccessPodesavanja();

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
          <span class="hub-brand-title">${APP_PRODUCT_NAME}</span>
          <span class="hub-brand-sub">Servoteh · MES</span>
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
        <p>Izaberi modul sa kojim želiš da radiš. Aktivni moduli: <strong style="color:var(--text)">Plan Montaže</strong>, <strong style="color:var(--text)">Lokacije delova</strong>, <strong style="color:var(--text)">Održavanje mašina</strong> (skelet), <strong style="color:var(--text)">Planiranje proizvodnje</strong>, <strong style="color:var(--text)">Praćenje proizvodnje</strong>, <strong style="color:var(--text)">Sastanci</strong>, <strong style="color:var(--text)">Projektni biro</strong> i <strong style="color:var(--text)">Kadrovska</strong>${canAccessPodesavanja() ? ' i <strong style="color:var(--text)">Podešavanja</strong>' : ''}.</p>
        <nav class="hub-quick-links" aria-label="Brzi linkovi modula">
          <span class="hub-quick-links-label">Brzo:</span>
          <a href="/projektni-biro" class="hub-quick-link" data-module="projektni-biro">Projektni biro</a>
          <span class="hub-quick-links-sep" aria-hidden="true">·</span>
          <a href="/plan-montaze" class="hub-quick-link" data-module="plan-montaze">Plan Montaže</a>
          <span class="hub-quick-links-sep" aria-hidden="true">·</span>
          <a href="/plan-proizvodnje" class="hub-quick-link" data-module="plan-proizvodnje">Plan proizvodnje</a>
        </nav>
      </div>

      <div class="hub-grid">
        <button type="button" class="hub-card" data-module="projektni-biro" aria-label="Otvori Projektni biro">
          <div class="hub-card-icon" aria-hidden="true">📐</div>
          <div class="hub-card-title">Projektni biro</div>
          <div class="hub-card-desc">Plan rada inženjera po projektima: zadaci, rokovi, opterećenje i alarmi. Kanban i izveštaji u sledećim fazama.</div>
          <div class="hub-card-footer">
            <span class="hub-card-cta">Otvori →</span>
            <span class="hub-card-badge badge-active">PB1</span>
          </div>
        </button>

        <button type="button" class="hub-card" data-module="plan-montaze" aria-label="Otvori Plan Montaže">
          <div class="hub-card-icon" aria-hidden="true">🛠</div>
          <div class="hub-card-title">Plan Montaže</div>
          <div class="hub-card-desc">Planiraj i prati faze montaže po projektima i pozicijama. Gantogram, spremnost, odgovorni, rizici, export u PDF/Excel.</div>
          <div class="hub-card-footer">
            <span class="hub-card-cta">Otvori →</span>
            <span class="hub-card-badge badge-active">Aktivno</span>
          </div>
        </button>

        <button type="button" class="hub-card${canAccessLokacije() ? '' : ' is-disabled'}" data-module="lokacije-delova" aria-label="Otvori Lokacije delova"${canAccessLokacije() ? '' : ' aria-disabled="true"'}>
          <div class="hub-card-icon" aria-hidden="true">📍</div>
          <div class="hub-card-title">Lokacije delova</div>
          <div class="hub-card-desc">Evidencija gde se fizički nalaze delovi, sklopovi i alati: regal, polica, magacin, projektna lokacija. Pregled lokacija, stavki i sync reda.</div>
          <div class="hub-card-footer">
            <span class="hub-card-cta">${canAccessLokacije() ? 'Otvori →' : 'Prijavi se'}</span>
            <span class="hub-card-badge badge-active">${canAccessLokacije() ? 'Aktivno' : 'Zaključano'}</span>
          </div>
        </button>

        <button type="button" class="hub-card" data-module="odrzavanje-masina" aria-label="Otvori Održavanje mašina">
          <div class="hub-card-icon" aria-hidden="true">🛠</div>
          <div class="hub-card-title">Održavanje mašina</div>
          <div class="hub-card-desc">Plan i evidencija preventivnog i korektivnog održavanja: intervalni servisi, kvarovi, deep linkovi sa URL-a (/maintenance/…).</div>
          <div class="hub-card-footer">
            <span class="hub-card-cta">Otvori →</span>
            <span class="hub-card-badge badge-active">Skelet</span>
          </div>
        </button>

        <button type="button" class="hub-card${canAccessSastanci() ? '' : ' is-disabled'}" data-module="sastanci" aria-label="Otvori Sastanke"${canAccessSastanci() ? '' : ' aria-disabled="true"'}>
          <div class="hub-card-icon" aria-hidden="true">📅</div>
          <div class="hub-card-title">Sastanci</div>
          <div class="hub-card-desc">Sedmični i projektni sastanci sa dnevnim redom, učesnicima i zapisnicima. Akcioni plan sa rokovima i odgovornima, presek stanja sa slikama, arhiva starih sastanaka.</div>
          <div class="hub-card-footer">
            <span class="hub-card-cta">${canAccessSastanci() ? (canEditSastanci() ? 'Otvori →' : 'Pregled (read-only)') : 'Pristup zaključan'}</span>
            <span class="hub-card-badge ${canAccessSastanci() ? 'badge-active' : ''}">${canAccessSastanci() ? 'Aktivno' : 'Zaključano'}</span>
          </div>
        </button>

        <button type="button" class="hub-card" data-module="plan-proizvodnje" aria-label="Otvori Planiranje proizvodnje">
          <div class="hub-card-icon" aria-hidden="true">🏭</div>
          <div class="hub-card-title">Planiranje proizvodnje</div>
          <div class="hub-card-desc">Šef mašinske obrade postavlja redosled operacija po mašini, status, napomene i premešta posao između mašina. Podaci iz BigTehn-a (RN, crteži, rokovi) automatski.</div>
          <div class="hub-card-footer">
            <span class="hub-card-cta">${canEditPlanProizvodnje() ? 'Otvori →' : 'Pregled (read-only)'}</span>
            <span class="hub-card-badge badge-active">Aktivno</span>
          </div>
        </button>

        <button type="button" class="hub-card" data-module="pracenje-proizvodnje" aria-label="Otvori Praćenje proizvodnje">
          <div class="hub-card-icon" aria-hidden="true">▣</div>
          <div class="hub-card-title">Praćenje proizvodnje</div>
          <div class="hub-card-desc">Live pregled RN-a po pozicijama i operativni plan aktivnosti po odeljenjima. Vezano na production RPC-je iz Faza 2 osnove.</div>
          <div class="hub-card-footer">
            <span class="hub-card-cta">Otvori →</span>
            <span class="hub-card-badge badge-active">Skelet</span>
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

  function trySelectModule(moduleId) {
    if (moduleId === 'kadrovska' && !canAccessKadrovska()) {
      showToast('🔒 Kadrovska je dostupna samo HR/admin korisnicima');
      return;
    }
    if (moduleId === 'sastanci' && !canAccessSastanci()) {
      showToast('🔒 Sastanci zahtevaju validnu autentifikaciju');
      return;
    }
    if (moduleId === 'lokacije-delova' && !canAccessLokacije()) {
      showToast('🔒 Lokacije delova zahtevaju prijavu');
      return;
    }
    onModuleSelect?.(moduleId);
  }

  container.querySelectorAll('button[data-module]').forEach(btn => {
    btn.addEventListener('click', () => trySelectModule(btn.dataset.module));
  });

  container.querySelectorAll('a.hub-quick-link[data-module]').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      trySelectModule(a.dataset.module);
    });
  });

  return container;
}
