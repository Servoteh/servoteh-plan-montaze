/**
 * Plan Proizvodnje — Drawing Manager (Sprint F.4).
 *
 * Modal popup za upravljanje skicama/slikama jedne operacije.
 *
 * Funkcije:
 *   - Listanje postojećih (deleted_at IS NULL) skica iz production_drawings
 *   - Upload (file input + drag-drop area), max 20 MB, samo image/pdf
 *   - Klik na sličicu → otvara signed URL u novom tab-u (preview)
 *   - Soft-delete sa "potvrdi" korakom
 *   - Read-only za role koje nisu admin/pm
 *
 * Public API:
 *   openDrawingManager({
 *     work_order_id, line_id, opTitle,   // identifikacija operacije
 *     canEdit,                            // true = upload+delete dugmad aktivna
 *     onChange                            // callback(newCount) posle uspešne promene
 *   })
 *   — vraća promise koji rešava kad se modal zatvori
 */

import { escHtml, showToast } from '../../lib/dom.js';
import {
  loadDrawings,
  uploadDrawing,
  softDeleteDrawing,
  getDrawingSignedUrl,
} from '../../services/planProizvodnje.js';

const ALLOWED_MIMES = [
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic',
  'application/pdf',
];
const MAX_BYTES = 20 * 1024 * 1024; /* sinhronizuj sa SQL bucket-om */

/* Singleton — istovremeno samo jedan modal otvoren */
let activeModal = null;

export function openDrawingManager(opts) {
  if (activeModal) {
    /* Zatvori prethodni i otvori novi */
    activeModal.close();
  }
  return new Promise((resolve) => {
    const m = createModal(opts, resolve);
    activeModal = m;
    document.body.appendChild(m.root);
    /* Fokusiraj close dugme za accessibility */
    setTimeout(() => m.root.querySelector('.dm-close')?.focus(), 50);
  });
}

/* ── Internal ── */

function createModal({ work_order_id, line_id, opTitle, canEdit, onChange }, resolve) {
  const state = {
    drawings: [],
    loading: true,
    error: null,
    uploading: false,
  };

  const root = document.createElement('div');
  root.className = 'dm-overlay';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Upravljanje skicama');
  root.innerHTML = `
    <div class="dm-modal" role="document">
      <header class="dm-header">
        <div class="dm-header-title">
          <span class="dm-icon" aria-hidden="true">📎</span>
          <div>
            <div class="dm-title">Skice / slike</div>
            <div class="dm-subtitle">${escHtml(opTitle || '—')}</div>
          </div>
        </div>
        <button type="button" class="dm-close" aria-label="Zatvori (Esc)">✕</button>
      </header>

      <main class="dm-body">
        ${canEdit ? `
          <div class="dm-uploader" id="dmUploader">
            <input type="file" id="dmFileInput" accept="image/*,application/pdf" multiple hidden>
            <div class="dm-uploader-icon">⬆️</div>
            <div class="dm-uploader-text">
              <strong>Klikni</strong> ili prevuci slike/PDF ovde
            </div>
            <div class="dm-uploader-hint">JPG · PNG · WEBP · HEIC · PDF · max 20 MB</div>
          </div>
        ` : `
          <div class="dm-readonly-note">🔒 Read-only — za upload je potrebna rola <strong>admin</strong> ili <strong>pm</strong>.</div>
        `}

        <div class="dm-progress" id="dmProgress" style="display:none">
          <span class="dm-spinner"></span>
          <span id="dmProgressLabel">Uploadujem…</span>
        </div>

        <div class="dm-error" id="dmError" style="display:none"></div>

        <div class="dm-gallery" id="dmGallery">
          <div class="dm-state">⏳ Učitavam skice…</div>
        </div>
      </main>
    </div>
  `;

  /* Wire close ways */
  function close() {
    if (activeModal !== m) return;
    activeModal = null;
    document.removeEventListener('keydown', onKeyDown);
    root.remove();
    resolve(state.drawings.length);
  }
  function onKeyDown(e) {
    if (e.key === 'Escape') close();
  }
  document.addEventListener('keydown', onKeyDown);
  root.querySelector('.dm-close').addEventListener('click', close);
  root.addEventListener('click', (e) => {
    if (e.target === root) close();
  });

  /* Wire uploader */
  if (canEdit) {
    const uploader = root.querySelector('#dmUploader');
    const fileInput = root.querySelector('#dmFileInput');
    uploader.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const files = Array.from(fileInput.files || []);
      fileInput.value = '';
      if (files.length) handleUpload(files);
    });
    /* Drag-drop */
    ['dragenter', 'dragover'].forEach(ev => {
      uploader.addEventListener(ev, (e) => {
        e.preventDefault();
        uploader.classList.add('is-dragover');
      });
    });
    ['dragleave', 'drop'].forEach(ev => {
      uploader.addEventListener(ev, (e) => {
        e.preventDefault();
        uploader.classList.remove('is-dragover');
      });
    });
    uploader.addEventListener('drop', (e) => {
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length) handleUpload(files);
    });
  }

  /* ── Render helpers ── */

  function showError(msg) {
    state.error = msg;
    const box = root.querySelector('#dmError');
    box.textContent = msg || '';
    box.style.display = msg ? 'block' : 'none';
  }
  function showProgress(on, label) {
    const box = root.querySelector('#dmProgress');
    const lbl = root.querySelector('#dmProgressLabel');
    box.style.display = on ? 'flex' : 'none';
    if (label) lbl.textContent = label;
  }

  function renderGallery() {
    const host = root.querySelector('#dmGallery');
    if (state.loading) {
      host.innerHTML = '<div class="dm-state">⏳ Učitavam skice…</div>';
      return;
    }
    if (!state.drawings.length) {
      host.innerHTML = `
        <div class="dm-state dm-empty">
          <div style="font-size:32px;opacity:0.5">📭</div>
          <div>Još nema skica za ovu operaciju.</div>
          ${canEdit ? '<div class="dm-hint">Dodaj prvu kroz uploader gore.</div>' : ''}
        </div>`;
      return;
    }
    host.innerHTML = state.drawings.map(d => {
      const isImage = (d.mime_type || '').startsWith('image/');
      const isPdf   = d.mime_type === 'application/pdf';
      const sizeKb  = d.size_bytes ? Math.round(d.size_bytes / 1024) : null;
      const dateStr = d.uploaded_at
        ? new Date(d.uploaded_at).toLocaleString('sr-RS', { dateStyle: 'short', timeStyle: 'short' })
        : '—';
      const icon = isImage ? '🖼️' : isPdf ? '📄' : '📎';
      const thumb = isImage
        ? `<img class="dm-thumb-img" data-path="${escHtml(d.storage_path)}" alt="${escHtml(d.file_name)}" loading="lazy">`
        : `<div class="dm-thumb-icon">${icon}</div>`;
      return `
        <div class="dm-card" data-id="${d.id}">
          <button type="button" class="dm-thumb" data-action="open" data-path="${escHtml(d.storage_path)}" title="Otvori u novom tab-u">
            ${thumb}
          </button>
          <div class="dm-meta">
            <div class="dm-meta-name" title="${escHtml(d.file_name)}">${escHtml(d.file_name)}</div>
            <div class="dm-meta-info">
              ${sizeKb ? `${sizeKb} KB · ` : ''}${escHtml(dateStr)}
              ${d.uploaded_by ? `<br>${escHtml(d.uploaded_by)}` : ''}
            </div>
          </div>
          <div class="dm-actions">
            <button type="button" class="dm-btn dm-btn-open" data-action="open" data-path="${escHtml(d.storage_path)}" title="Otvori">↗</button>
            ${canEdit ? `<button type="button" class="dm-btn dm-btn-del" data-action="del" data-id="${d.id}" title="Obriši">🗑</button>` : ''}
          </div>
        </div>
      `;
    }).join('');

    /* Wire actions */
    host.querySelectorAll('[data-action="open"]').forEach(el => {
      el.addEventListener('click', () => openInNewTab(el.dataset.path));
    });
    host.querySelectorAll('[data-action="del"]').forEach(el => {
      el.addEventListener('click', () => handleDelete(Number(el.dataset.id)));
    });

    /* Lazy load image thumbnails — uvek kroz signed URL */
    host.querySelectorAll('.dm-thumb-img[data-path]').forEach(async (img) => {
      const path = img.dataset.path;
      const url = await getDrawingSignedUrl(path, 300);
      if (url) img.src = url;
      else img.replaceWith(Object.assign(document.createElement('div'), {
        className: 'dm-thumb-icon', textContent: '⚠️',
      }));
    });
  }

  /* ── Actions ── */

  async function reload() {
    state.loading = true;
    renderGallery();
    try {
      state.drawings = await loadDrawings({ work_order_id, line_id });
    } catch (e) {
      console.error('[dm] loadDrawings', e);
      showError('Greška pri učitavanju skica.');
      state.drawings = [];
    }
    state.loading = false;
    renderGallery();
    if (typeof onChange === 'function') onChange(state.drawings.length);
  }

  async function handleUpload(files) {
    showError('');
    /* Validacija */
    const valid = [];
    for (const f of files) {
      if (!ALLOWED_MIMES.includes(f.type) && !f.type.startsWith('image/')) {
        showToast(`Nepodržan tip: ${f.name} (${f.type})`, 'warn');
        continue;
      }
      if (f.size > MAX_BYTES) {
        showToast(`${f.name}: prevelik (max 20 MB)`, 'warn');
        continue;
      }
      valid.push(f);
    }
    if (!valid.length) return;

    state.uploading = true;
    let okCount = 0;
    for (let i = 0; i < valid.length; i++) {
      const f = valid[i];
      showProgress(true, `Uploadujem ${i + 1}/${valid.length} — ${f.name}`);
      const res = await uploadDrawing({ work_order_id, line_id, file: f });
      if (res) okCount += 1;
      else showToast(`Upload neuspešan: ${f.name}`, 'error');
    }
    showProgress(false);
    state.uploading = false;
    if (okCount > 0) showToast(`Dodato ${okCount} skic${okCount === 1 ? 'a' : 'a'}`, 'success');
    await reload();
  }

  async function handleDelete(id) {
    const d = state.drawings.find(x => x.id === id);
    if (!d) return;
    const ok = confirm(`Obrisati skicu „${d.file_name}”?\n\n(Soft-delete — može se kasnije vratiti iz baze.)`);
    if (!ok) return;
    showProgress(true, 'Brišem…');
    const success = await softDeleteDrawing(d);
    showProgress(false);
    if (!success) {
      showToast('Greška pri brisanju.', 'error');
      return;
    }
    showToast('Skica obrisana.', 'success');
    await reload();
  }

  async function openInNewTab(storagePath) {
    if (!storagePath) return;
    const url = await getDrawingSignedUrl(storagePath, 300);
    if (!url) {
      showToast('Ne mogu da generisem URL za pregled.', 'error');
      return;
    }
    window.open(url, '_blank', 'noopener');
  }

  /* Initial load */
  reload();

  const m = { root, close };
  return m;
}
