/**
 * Placeholder body za Kadrovska tabove koji još nisu portovani u Vite (F4.x).
 *
 * Bit-paritetnu funkcionalnost (Odsustva, Sati, Ugovori, Mesečni grid,
 * Izveštaji) imamo u legacy/index.html i biće portovana u narednim
 * iteracijama Faze 4. Do tad korisnik vidi jasan info banner sa savetom
 * kako da koristi legacy verziju za te tabove.
 */

import { escHtml } from '../../lib/dom.js';

export function renderComingSoonTab(label, plannedPhase) {
  return `
    <main class="kadrovska-main">
      <div class="kadrovska-empty" style="margin-top:30px;">
        <div class="kadrovska-empty-title">${escHtml(label)} — port u toku</div>
        <div style="margin-top:8px">
          Ovaj tab je već dostupan u <strong>legacy verziji</strong> aplikacije
          na <code>servoteh-plan-montaze.pages.dev</code>. Port u Vite verziju
          dolazi u <strong>${escHtml(plannedPhase)}</strong>.
        </div>
        <div style="margin-top:8px;color:var(--text3);font-size:12px;">
          Migracija ide tab po tab da bi svaki commit ostavio aplikaciju u radnom stanju.
          Ostali Kadrovska tabovi (Zaposleni, podaci, role) rade normalno.
        </div>
      </div>
    </main>`;
}
