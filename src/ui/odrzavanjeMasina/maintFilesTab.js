/**
 * UI: tab „Dokumenti" u detalju mašine.
 * Zavisi od sql/migrations/add_maint_machine_files.sql (tabela
 * maint_machine_files i Storage bucket maint-machine-files).
 */

import {
  fetchMaintMachineFiles,
  uploadMaintMachineFile,
  getMaintMachineFileSignedUrl,
  deleteMaintMachineFile,
  patchMaintMachineFile,
} from '../../services/maintenance.js';
import { getCurrentUser } from '../../state/auth.js';
import { showToast } from '../../lib/dom.js';

/* ── Helpers ────────────────────────────────────────────────────────────── */

function escHtml(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escAttr(v) { return escHtml(v); }

const CATEGORIES = [
  { id: 'manual',          label: 'Uputstvo' },
  { id: 'photo',           label: 'Fotografija' },
  { id: 'drawing',         label: 'Tehnički crtež' },
  { id: 'service_report',  label: 'Servisni izveštaj' },
  { id: 'warranty',        label: 'Garantni list' },
  { id: 'invoice',         label: 'Račun' },
  { id: 'other',           label: 'Drugo' },
];
function categoryLabel(id) {
  const row = CATEGORIES.find(c => c.id === id);
  return row ? row.label : (id || '—');
}

function fileIcon(mime, name) {
  const m = String(mime || '').toLowerCase();
  const n = String(name || '').toLowerCase();
  if (m.startsWith('image/')) return '🖼';
  if (m === 'application/pdf' || n.endsWith('.pdf')) return '📄';
  if (m.includes('spreadsheet') || n.endsWith('.xls') || n.endsWith('.xlsx') || n.endsWith('.csv')) return '📊';
  if (m.includes('word') || n.endsWith('.doc') || n.endsWith('.docx')) return '📝';
  if (m.startsWith('text/')) return '📝';
  return '📎';
}

function fmtSize(bytes) {
  if (bytes == null) return '';
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(2) + ' MB';
}

/**
 * Može li tekući korisnik da dodaje/bar vidi upload formu?
 * RLS na storage-u i tabeli dozvoljava ≥ operator; komplementarno UI dugme
 * sakriva za niže.
 */
export function canUploadMaintFiles(profile) {
  const role = String(profile?.role || '').toLowerCase();
  return ['operator', 'technician', 'chief', 'admin'].includes(role)
      || !!profile?.isErpAdmin;
}

function canDeleteFile(file, profile) {
  const role = String(profile?.role || '').toLowerCase();
  if (role === 'chief' || role === 'admin' || profile?.isErpAdmin) return true;
  const me = getCurrentUser();
  if (!me?.id || !file?.uploaded_by) return false;
  if (file.uploaded_by !== me.id) return false;
  const ts = file.uploaded_at ? new Date(file.uploaded_at).getTime() : 0;
  const withinDay = ts && (Date.now() - ts) < 24 * 3600 * 1000;
  return !!withinDay && ['operator', 'technician'].includes(role);
}

/* ── Render + interakcije ───────────────────────────────────────────────── */

/**
 * Iscrtaj tab „Dokumenti" u dati host element.
 * @param {HTMLElement} host kontejner (mnt-panel)
 * @param {string} machineCode
 * @param {object|null} profile maint profil tekućeg korisnika
 * @param {{ archived?: boolean, onChanged?: () => void }} [opts]
 */
export async function renderMaintFilesTab(host, machineCode, profile, opts = {}) {
  if (!host) return;
  host.innerHTML = `<p class="mnt-muted">Učitavanje…</p>`;
  const files = await fetchMaintMachineFiles(machineCode);
  if (!host.isConnected) return;

  const canAdd = canUploadMaintFiles(profile) && !opts.archived;

  const listHtml = files.length
    ? files.map(f => {
        const canDel = canDeleteFile(f, profile);
        return `
          <li data-mmf-id="${escAttr(f.id)}" style="display:flex;gap:12px;align-items:flex-start;padding:10px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;background:var(--surface)">
            <div style="font-size:28px;line-height:1;flex:none">${fileIcon(f.mime_type, f.file_name)}</div>
            <div style="flex:1;min-width:0">
              <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
                <button type="button" class="mnt-linkish" data-mmf-open="${escAttr(f.id)}" style="font-weight:600">${escHtml(f.file_name)}</button>
                ${f.category ? `<span class="mnt-badge" style="background:var(--surface3);padding:2px 8px;border-radius:999px;font-size:11px">${escHtml(categoryLabel(f.category))}</span>` : ''}
              </div>
              ${f.description ? `<div style="margin-top:4px;white-space:pre-wrap;color:var(--text-muted);font-size:13px">${escHtml(f.description)}</div>` : ''}
              <div class="mnt-muted" style="font-size:11px;margin-top:4px">
                ${escHtml((f.uploaded_at || '').replace('T', ' ').slice(0, 16))}
                ${f.size_bytes ? ` · ${escHtml(fmtSize(f.size_bytes))}` : ''}
              </div>
            </div>
            <div style="display:flex;gap:6px;flex:none">
              <button type="button" class="btn" style="padding:4px 10px;font-size:12px" data-mmf-open="${escAttr(f.id)}">Otvori</button>
              ${canDel ? `<button type="button" class="btn" style="padding:4px 10px;font-size:12px;background:var(--surface3)" data-mmf-edit="${escAttr(f.id)}">Uredi</button>` : ''}
              ${canDel ? `<button type="button" class="btn" style="padding:4px 10px;font-size:12px;background:var(--red-bg);color:var(--red)" data-mmf-del="${escAttr(f.id)}">Obriši</button>` : ''}
            </div>
          </li>`;
      }).join('')
    : '<li class="mnt-muted">Nema dokumenata uz ovu mašinu.</li>';

  const addBlock = canAdd
    ? `<form id="mmfUploadForm" style="margin-top:16px;padding:12px;border:1px dashed var(--border);border-radius:8px;background:var(--surface2)">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div style="grid-column:1 / -1">
            <label class="form-label" for="mmfFile">Izaberi fajl *</label>
            <input type="file" id="mmfFile" required
              accept="application/pdf,image/*,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/csv">
            <p class="form-hint" style="font-size:11px">Dozvoljeno: PDF, slike, Word, Excel, CSV, TXT. Max 25 MB.</p>
          </div>
          <div>
            <label class="form-label" for="mmfCat">Kategorija</label>
            <select class="form-input" id="mmfCat">
              <option value="">—</option>
              ${CATEGORIES.map(c => `<option value="${escAttr(c.id)}">${escHtml(c.label)}</option>`).join('')}
            </select>
          </div>
          <div>
            <label class="form-label" for="mmfDesc">Kratak opis</label>
            <input class="form-input" id="mmfDesc" maxlength="500" placeholder="npr. Uputstvo proizvođača, 2019">
          </div>
        </div>
        <div id="mmfUploadErr" class="form-err" style="display:none;margin-top:6px"></div>
        <p style="margin-top:10px"><button type="submit" class="btn" id="mmfUploadBtn">Dodaj dokument</button></p>
      </form>`
    : (opts.archived
        ? '<p class="mnt-muted" style="margin-top:12px"><em>Mašina je arhivirana — upload onemogućen.</em></p>'
        : '<p class="mnt-muted" style="margin-top:12px"><em>Za upload je potreban profil održavanja (operator i više).</em></p>');

  host.innerHTML = `
    <p class="mnt-muted">Dokumenti uz mašinu: uputstva, fotografije, crteži, servisni izveštaji, računi. Klik na naziv otvara fajl u novom tab-u preko privremenog signed URL-a.</p>
    <ul class="mnt-list" style="list-style:none;padding:0;margin:0">${listHtml}</ul>
    ${addBlock}`;

  /* ── Events ── */

  host.querySelectorAll('[data-mmf-open]').forEach(el => {
    el.addEventListener('click', async (ev) => {
      ev.preventDefault();
      const id = el.getAttribute('data-mmf-open');
      const file = files.find(f => f.id === id);
      if (!file) return;
      const orig = el.textContent;
      const wasButton = el.tagName === 'BUTTON';
      if (wasButton) { el.disabled = true; el.textContent = '…'; }
      const url = await getMaintMachineFileSignedUrl(file.storage_path, 300);
      if (wasButton) { el.disabled = false; el.textContent = orig; }
      if (!url) { showToast('❌ Nije moguće dobiti link (RLS?).'); return; }
      window.open(url, '_blank', 'noopener');
    });
  });

  host.querySelectorAll('[data-mmf-del]').forEach(el => {
    el.addEventListener('click', async () => {
      const id = el.getAttribute('data-mmf-del');
      const file = files.find(f => f.id === id);
      if (!file) return;
      // eslint-disable-next-line no-alert
      if (!confirm(`Obrisati dokument „${file.file_name}”?`)) return;
      el.disabled = true;
      el.textContent = '…';
      const ok = await deleteMaintMachineFile(file);
      if (!ok) {
        el.disabled = false;
        el.textContent = 'Obriši';
        showToast('❌ Brisanje nije uspelo.');
        return;
      }
      showToast('🗑 Dokument obrisan.');
      opts.onChanged?.();
      renderMaintFilesTab(host, machineCode, profile, opts);
    });
  });

  host.querySelectorAll('[data-mmf-edit]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.getAttribute('data-mmf-edit');
      const file = files.find(f => f.id === id);
      if (!file) return;
      openMaintFileEditModal(file, () => {
        opts.onChanged?.();
        renderMaintFilesTab(host, machineCode, profile, opts);
      });
    });
  });

  const form = host.querySelector('#mmfUploadForm');
  if (form) {
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const fileInput = /** @type {HTMLInputElement} */ (form.querySelector('#mmfFile'));
      const file = fileInput?.files?.[0];
      const errBox = form.querySelector('#mmfUploadErr');
      const setErr = (msg) => {
        if (!errBox) return;
        errBox.textContent = msg || '';
        errBox.style.display = msg ? 'block' : 'none';
      };
      setErr('');
      if (!file) { setErr('Izaberi fajl.'); return; }
      if (file.size > 25 * 1024 * 1024) {
        setErr('Fajl je veći od 25 MB.');
        return;
      }
      const cat = /** @type {HTMLSelectElement} */ (form.querySelector('#mmfCat'))?.value || '';
      const desc = /** @type {HTMLInputElement} */ (form.querySelector('#mmfDesc'))?.value || '';
      const btn = /** @type {HTMLButtonElement} */ (form.querySelector('#mmfUploadBtn'));
      btn.disabled = true;
      btn.textContent = 'Uploadujem…';
      const res = await uploadMaintMachineFile({
        machineCode,
        file,
        category: cat || null,
        description: desc || null,
      });
      btn.disabled = false;
      btn.textContent = 'Dodaj dokument';
      if (!res.ok) {
        setErr(res.error || 'Upload nije uspeo.');
        return;
      }
      showToast('✅ Dokument dodat.');
      opts.onChanged?.();
      renderMaintFilesTab(host, machineCode, profile, opts);
    });
  }
}

/* ── Edit modal (samo metadata: kategorija + opis) ─────────────────────── */

function openMaintFileEditModal(file, onSaved) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:1000';
  wrap.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" style="background:var(--surface);padding:20px;border-radius:10px;max-width:500px;width:90%">
      <h3 style="margin:0 0 12px;font-size:16px">Uredi dokument: <code style="font-size:13px">${escHtml(file.file_name)}</code></h3>
      <form id="mmfEdForm">
        <div style="margin-bottom:10px">
          <label class="form-label" for="mmfEdCat">Kategorija</label>
          <select class="form-input" id="mmfEdCat">
            <option value="">—</option>
            ${CATEGORIES.map(c => `<option value="${escAttr(c.id)}" ${file.category === c.id ? 'selected' : ''}>${escHtml(c.label)}</option>`).join('')}
          </select>
        </div>
        <div style="margin-bottom:10px">
          <label class="form-label" for="mmfEdDesc">Opis</label>
          <input class="form-input" id="mmfEdDesc" maxlength="500" value="${escAttr(file.description || '')}">
        </div>
        <div id="mmfEdErr" class="form-err" style="display:none;margin-bottom:8px"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button type="button" class="btn" id="mmfEdCancel" style="background:var(--surface3)">Otkaži</button>
          <button type="submit" class="btn">Snimi</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.querySelector('#mmfEdCancel')?.addEventListener('click', close);
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
  wrap.querySelector('#mmfEdForm')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const cat = /** @type {HTMLSelectElement} */ (wrap.querySelector('#mmfEdCat'))?.value || '';
    const desc = /** @type {HTMLInputElement} */ (wrap.querySelector('#mmfEdDesc'))?.value || '';
    const errBox = wrap.querySelector('#mmfEdErr');
    const res = await patchMaintMachineFile(file.id, {
      category: cat || null,
      description: desc || null,
    });
    if (!res) {
      if (errBox) { errBox.textContent = 'Snimanje nije uspelo (RLS?).'; errBox.style.display = 'block'; }
      return;
    }
    showToast('✅ Dokument ažuriran.');
    close();
    onSaved?.();
  });
}
