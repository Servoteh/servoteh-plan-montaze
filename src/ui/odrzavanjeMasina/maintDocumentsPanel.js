/**
 * CMMS dokumenti — polimorfni registar `maint_documents`.
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { isAdminOrMenadzment } from '../../state/auth.js';
import {
  fetchMaintAssetsForPicker,
  fetchMaintDocuments,
  uploadMaintDocument,
  getMaintDocumentSignedUrl,
  deleteMaintDocument,
} from '../../services/maintenance.js';

const DOC_CATEGORIES = [
  { id: 'manual', label: 'Uputstvo' },
  { id: 'photo', label: 'Fotografija' },
  { id: 'drawing', label: 'Tehnički crtež' },
  { id: 'service_report', label: 'Servisni izveštaj' },
  { id: 'warranty', label: 'Garancija' },
  { id: 'invoice', label: 'Račun' },
  { id: 'inspection', label: 'Inspekcija' },
  { id: 'other', label: 'Drugo' },
];

function canUploadDocs(profile) {
  const role = String(profile?.role || '').toLowerCase();
  return isAdminOrMenadzment() || ['operator', 'technician', 'chief', 'admin'].includes(role);
}

function canDeleteDoc(profile, doc) {
  const role = String(profile?.role || '').toLowerCase();
  if (isAdminOrMenadzment() || role === 'chief' || role === 'admin') return true;
  const ts = doc?.uploaded_at ? new Date(doc.uploaded_at).getTime() : 0;
  return !!ts && Date.now() - ts < 24 * 3600 * 1000 && ['operator', 'technician'].includes(role);
}

function categoryLabel(id) {
  return DOC_CATEGORIES.find(c => c.id === id)?.label || id || '—';
}

function fileIcon(mime, name) {
  const m = String(mime || '').toLowerCase();
  const n = String(name || '').toLowerCase();
  if (m.startsWith('image/')) return 'IMG';
  if (m === 'application/pdf' || n.endsWith('.pdf')) return 'PDF';
  if (m.includes('spreadsheet') || n.endsWith('.xls') || n.endsWith('.xlsx') || n.endsWith('.csv')) return 'XLS';
  if (m.includes('word') || n.endsWith('.doc') || n.endsWith('.docx')) return 'DOC';
  return 'FILE';
}

function fmtSize(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function assetDisplay(a) {
  return `${a.asset_code || ''} — ${a.name || ''}`;
}

/**
 * @param {HTMLElement} host
 * @param {{ prof: object|null }} opts
 */
export async function renderMaintDocumentsPanel(host, opts) {
  const { prof } = opts;
  const canAdd = canUploadDocs(prof);
  host.innerHTML = `<div class="mnt-panel"><p class="mnt-muted">Učitavam dokumente…</p></div>`;
  const [docs, assets] = await Promise.all([
    fetchMaintDocuments({ limit: 500 }),
    fetchMaintAssetsForPicker({ limit: 500 }),
  ]);
  if (!host.isConnected) return;

  const assetOpts = assets.map(a => `<option value="${escHtml(assetDisplay(a))}"></option>`).join('');
  const categoryOpts = DOC_CATEGORIES.map(c => `<option value="${escHtml(c.id)}">${escHtml(c.label)}</option>`).join('');
  const listHtml = docs.length
    ? docs.map(d => {
        const asset = d.maint_assets || {};
        const target = d.entity_type === 'asset'
          ? `${asset.asset_code || '—'} · ${asset.name || '—'}`
          : d.entity_type === 'work_order'
            ? `${d.maint_work_orders?.wo_number || 'WO'} · ${d.maint_work_orders?.title || ''}`
            : d.entity_type === 'incident'
              ? `Incident · ${d.maint_incidents?.title || ''}`
              : 'Preventiva';
        return `<li class="mnt-doc-row" data-mnt-doc-id="${escHtml(d.document_id)}">
          <div class="mnt-doc-icon">${escHtml(fileIcon(d.mime_type, d.file_name))}</div>
          <div class="mnt-doc-main">
            <button type="button" class="mnt-linkish" data-mnt-doc-open="${escHtml(d.document_id)}">${escHtml(d.file_name || '')}</button>
            <div class="mnt-muted">${escHtml(target)} · ${escHtml(categoryLabel(d.category))}${d.size_bytes ? ' · ' + escHtml(fmtSize(d.size_bytes)) : ''}</div>
            ${d.description ? `<div class="mnt-doc-desc">${escHtml(d.description)}</div>` : ''}
          </div>
          <div class="mnt-doc-actions">
            <button type="button" class="btn btn-xs" data-mnt-doc-open="${escHtml(d.document_id)}">Otvori</button>
            ${canDeleteDoc(prof, d) ? `<button type="button" class="btn btn-xs" data-mnt-doc-del="${escHtml(d.document_id)}">Obriši</button>` : ''}
          </div>
        </li>`;
      }).join('')
    : '<li class="mnt-muted">Nema dokumenata za prikaz.</li>';

  const uploadHtml = canAdd
    ? `<form id="mntDocUploadForm" class="mnt-doc-upload">
        <h3>Dodaj dokument uz sredstvo</h3>
        <div class="mnt-doc-upload-grid">
          <label class="form-label">Sredstvo *
            <input class="form-input" id="mntDocAsset" list="mntDocAssetList" required placeholder="Šifra ili naziv sredstva">
            <datalist id="mntDocAssetList">${assetOpts}</datalist>
          </label>
          <label class="form-label">Kategorija
            <select class="form-input" id="mntDocCategory"><option value="">—</option>${categoryOpts}</select>
          </label>
          <label class="form-label mnt-doc-upload-full">Fajl *
            <input class="form-input" id="mntDocFile" type="file" required
              accept="application/pdf,image/*,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/csv">
          </label>
          <label class="form-label mnt-doc-upload-full">Opis
            <input class="form-input" id="mntDocDesc" maxlength="500" placeholder="npr. servisni izveštaj, račun, garancija…">
          </label>
        </div>
        <div class="kadr-modal-err" id="mntDocErr"></div>
        <p style="margin:10px 0 0"><button type="submit" class="btn" id="mntDocUploadBtn">Upload dokumenta</button></p>
      </form>`
    : '<p class="mnt-muted">Za upload je potreban profil održavanja operator/tehničar ili više.</p>';

  host.innerHTML = `
    <div class="mnt-assets-head">
      <div>
        <h3 style="font-size:16px;margin:0 0 4px">Dokumenta</h3>
        <p class="mnt-muted" style="margin:0">Centralni CMMS registar dokumenata za sredstva, radne naloge, incidente i preventivu.</p>
      </div>
    </div>
    <div class="mnt-doc-layout">
      <section class="mnt-dash-card">
        <div class="mnt-att-head"><h3>Dokumenti</h3><span class="mnt-muted">${docs.length} prikazano</span></div>
        <ul class="mnt-doc-list">${listHtml}</ul>
      </section>
      <section class="mnt-dash-card">${uploadHtml}</section>
    </div>`;

  host.querySelectorAll('[data-mnt-doc-open]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-mnt-doc-open');
      const doc = docs.find(d => d.document_id === id);
      if (!doc) return;
      const url = await getMaintDocumentSignedUrl(doc.storage_path, 300);
      if (!url) {
        showToast('⚠ Link nije dostupan');
        return;
      }
      window.open(url, '_blank', 'noopener');
    });
  });
  host.querySelectorAll('[data-mnt-doc-del]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-mnt-doc-del');
      const doc = docs.find(d => d.document_id === id);
      if (!doc) return;
      // eslint-disable-next-line no-alert
      if (!confirm(`Obrisati dokument "${doc.file_name}"?`)) return;
      const ok = await deleteMaintDocument(doc);
      if (!ok) {
        showToast('⚠ Brisanje nije uspelo');
        return;
      }
      showToast('✅ Dokument obrisan');
      void renderMaintDocumentsPanel(host, opts);
    });
  });
  host.querySelector('#mntDocUploadForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const err = host.querySelector('#mntDocErr');
    if (err) err.textContent = '';
    const rawAsset = host.querySelector('#mntDocAsset')?.value?.trim() || '';
    const asset = assets.find(a => assetDisplay(a) === rawAsset || String(a.asset_code || '').toLowerCase() === rawAsset.toLowerCase());
    const file = host.querySelector('#mntDocFile')?.files?.[0] || null;
    if (!asset?.asset_id) {
      if (err) err.textContent = 'Izaberi sredstvo iz liste.';
      return;
    }
    if (!file) {
      if (err) err.textContent = 'Izaberi fajl.';
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      if (err) err.textContent = 'Fajl je veći od 25 MB.';
      return;
    }
    const btn = host.querySelector('#mntDocUploadBtn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Uploadujem…';
    }
    const res = await uploadMaintDocument({
      entityType: 'asset',
      entityId: asset.asset_id,
      file,
      category: host.querySelector('#mntDocCategory')?.value || null,
      description: host.querySelector('#mntDocDesc')?.value?.trim() || null,
    });
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Upload dokumenta';
    }
    if (!res.ok) {
      if (err) err.textContent = res.error || 'Upload nije uspeo.';
      return;
    }
    showToast('✅ Dokument dodat');
    void renderMaintDocumentsPanel(host, opts);
  });
}
