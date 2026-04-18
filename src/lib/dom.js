/**
 * Sitni DOM/UI helperi koje koriste više modula.
 *
 * - escHtml: identičan onom iz legacy/index.html (NE menjaj — koristi se
 *   svuda za XSS-safe interpolaciju u .innerHTML).
 * - $/$$ : kratki querySelector/querySelectorAll.
 * - showToast: očekuje da postoji <div class="toast" id="toast"></div>
 *   negde u DOM-u (mount-uje se u Faza 3 u app shell).
 */

export function escHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function $(sel, root = document) {
  return root.querySelector(sel);
}

export function $$(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

/**
 * Kreira toast element ako ne postoji i prikazuje poruku 2.5s.
 * (legacy je očekivao da je #toast u HTML-u; ovde sami obezbeđujemo.)
 */
export function showToast(msg) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.remove('show'), 2500);
}
