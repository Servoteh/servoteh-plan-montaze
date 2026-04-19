/**
 * Projektni sastanak — "Presek stanja" content.
 *
 * Renderuje hijerarhijsku listu aktivnosti (analogno tabeli iz Word fajla
 * "Zapisnik presek stanja i plan montaze - 14 oktobar.doc"):
 *   RB | Aktivnosti (rich text) | Odgovoran | Rok
 *
 * Plus galerija slika ispod svake aktivnosti.
 *
 * Rich text editor: koristi NATIVE contenteditable za MVP — bez dodavanja
 * teške zavisnosti (Quill/TipTap). Korisnik dobija basic toolbar
 * (bold, italic, underline, lista, indent, link). Output je sanitizovan
 * HTML (sanitizeHtml), upisan u presek_aktivnosti.sadrzaj_html.
 *
 * Drag-drop reorder aktivnosti: HTML5 native (draggable=true).
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { formatDate } from '../../lib/date.js';
import {
  loadAktivnosti, saveAktivnost, deleteAktivnost, reorderAktivnosti,
  loadSlike, uploadSlika, deleteSlika, getSlikaSignedUrl,
  AKTIVNOST_STATUSI, AKTIVNOST_STATUS_BOJE,
} from '../../services/projektniSastanak.js';

export async function renderProjektniContent(host, sast, { editable }) {
  host.innerHTML = '<div class="sast-loading">Učitavam presek stanja…</div>';

  let aktivnosti = await loadAktivnosti(sast.id);

  host.innerHTML = `
    <div class="sast-section sast-presek">
      <div class="sast-toolbar" style="margin-bottom:16px">
        <div>
          <h4 style="margin:0">Presek stanja po podstavkama (${aktivnosti.length})</h4>
          <small style="color:var(--text2)">Drag-drop za promenu redosleda. Slike se postavljaju po aktivnosti.</small>
        </div>
        ${editable ? '<button class="btn btn-primary" id="paAddBtn">+ Nova aktivnost</button>' : ''}
      </div>
      <div id="paList" class="sast-presek-list"></div>
    </div>
  `;

  await renderList();

  if (editable) {
    host.querySelector('#paAddBtn').addEventListener('click', () => {
      openAktivnostEditor({
        sast, editable,
        nextRb: (aktivnosti[aktivnosti.length - 1]?.rb || 0) + 1,
        nextRedosled: (aktivnosti[aktivnosti.length - 1]?.redosled || 0) + 10,
        onSaved: async (saved) => {
          aktivnosti.push(saved);
          aktivnosti.sort((a, b) => (a.redosled - b.redosled) || (a.rb - b.rb));
          await renderList();
        },
      });
    });
  }

  async function renderList() {
    const listEl = host.querySelector('#paList');
    if (!aktivnosti.length) {
      listEl.innerHTML = '<div class="sast-empty">Nema aktivnosti. Dodaj prvu klikom na "+ Nova aktivnost".</div>';
      return;
    }
    listEl.innerHTML = aktivnosti.map(a => renderAktivnostCard(a, editable)).join('');

    /* Wire drag-drop. */
    if (editable) wireDragDrop(listEl);

    /* Wire actions. */
    listEl.querySelectorAll('[data-act]').forEach(b => {
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = b.closest('[data-akt-id]')?.dataset.aktId;
        const a = aktivnosti.find(x => x.id === id);
        if (!a) return;
        const act = b.dataset.act;
        if (act === 'edit') {
          openAktivnostEditor({
            sast, editable, aktivnost: a,
            onSaved: async (saved) => {
              aktivnosti = aktivnosti.map(x => x.id === saved.id ? saved : x);
              await renderList();
            },
          });
        }
        if (act === 'delete') {
          if (!confirm(`Obriši aktivnost "${a.naslov}"?`)) return;
          const ok = await deleteAktivnost(id);
          if (ok) {
            aktivnosti = aktivnosti.filter(x => x.id !== id);
            await renderList();
          }
        }
        if (act === 'upload') {
          const inp = b.parentElement.querySelector('input[type=file]');
          inp?.click();
        }
      });
    });

    /* Wire upload inputs. */
    listEl.querySelectorAll('input[type=file][data-akt-upload]').forEach(inp => {
      inp.addEventListener('change', async (e) => {
        const aktId = inp.dataset.aktUpload;
        const files = Array.from(inp.files || []);
        if (!files.length) return;
        for (const f of files) {
          const r = await uploadSlika(sast.id, f, { aktivnostId: aktId });
          if (r) showToast(`📷 Slika "${f.name}" upload-ovana`);
          else showToast(`⚠ Greška pri upload-u "${f.name}"`);
        }
        inp.value = '';
        await renderList();
      });
    });

    /* Učitaj signed URL-ove za slike. */
    for (const a of aktivnosti) {
      const slike = await loadSlike(sast.id, a.id);
      const galHost = listEl.querySelector(`[data-akt-id="${a.id}"] .sast-presek-gal`);
      if (!galHost) continue;
      if (!slike.length) {
        galHost.innerHTML = '<div class="sast-presek-gal-empty">Nema slika</div>';
        continue;
      }
      galHost.innerHTML = await Promise.all(slike.map(async (s) => {
        const url = await getSlikaSignedUrl(s.storagePath);
        return `<figure class="sast-presek-thumb" data-slika-id="${s.id}">
          ${url ? `<img src="${escHtml(url)}" alt="${escHtml(s.fileName || '')}" loading="lazy">` : '<div class="sast-thumb-fallback">📷</div>'}
          ${s.caption ? `<figcaption>${escHtml(s.caption)}</figcaption>` : ''}
          ${editable ? `<button class="sast-thumb-del" data-slika-del="${s.id}" title="Obriši">🗑</button>` : ''}
        </figure>`;
      })).then(arr => arr.join(''));

      if (editable) {
        galHost.querySelectorAll('[data-slika-del]').forEach(b => {
          b.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!confirm('Obrisati sliku?')) return;
            const ok = await deleteSlika(b.dataset.slikaDel);
            if (ok) await renderList();
          });
        });
        galHost.querySelectorAll('img').forEach(img => {
          img.addEventListener('click', () => openImageLightbox(img.src));
        });
      } else {
        galHost.querySelectorAll('img').forEach(img => {
          img.addEventListener('click', () => openImageLightbox(img.src));
        });
      }
    }
  }

  function wireDragDrop(listEl) {
    let dragSrc = null;
    listEl.querySelectorAll('[data-akt-id]').forEach(card => {
      card.draggable = true;
      card.addEventListener('dragstart', () => {
        dragSrc = card;
        card.classList.add('is-dragging');
      });
      card.addEventListener('dragend', () => {
        card.classList.remove('is-dragging');
        listEl.querySelectorAll('.is-drag-over').forEach(el => el.classList.remove('is-drag-over'));
      });
      card.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (card !== dragSrc) card.classList.add('is-drag-over');
      });
      card.addEventListener('dragleave', () => card.classList.remove('is-drag-over'));
      card.addEventListener('drop', async (e) => {
        e.preventDefault();
        card.classList.remove('is-drag-over');
        if (!dragSrc || card === dragSrc) return;
        const srcId = dragSrc.dataset.aktId;
        const destId = card.dataset.aktId;
        const srcIdx = aktivnosti.findIndex(a => a.id === srcId);
        const destIdx = aktivnosti.findIndex(a => a.id === destId);
        if (srcIdx < 0 || destIdx < 0) return;
        const [moved] = aktivnosti.splice(srcIdx, 1);
        aktivnosti.splice(destIdx, 0, moved);
        /* Renumeriši redosled (po 10 da bismo imali prostora za umetanje). */
        const updates = aktivnosti.map((a, i) => ({ id: a.id, redosled: (i + 1) * 10 }));
        aktivnosti.forEach((a, i) => { a.redosled = (i + 1) * 10; });
        await reorderAktivnosti(updates);
        await renderList();
      });
    });
  }
}

function renderAktivnostCard(a, editable) {
  const c = AKTIVNOST_STATUS_BOJE[a.status] || '#666';
  return `
    <article class="sast-presek-card" data-akt-id="${a.id}">
      <header class="sast-presek-card-header">
        <div class="sast-presek-card-meta">
          <span class="sast-presek-rb">RB ${escHtml(String(a.rb))}</span>
          ${a.podRn ? `<span class="sast-presek-podrn">${escHtml(a.podRn)}</span>` : ''}
          <span class="sast-status-pill" style="background:${c}">${escHtml(AKTIVNOST_STATUSI[a.status] || a.status)}</span>
        </div>
        <h3 class="sast-presek-card-title">${escHtml(a.naslov)}</h3>
        <div class="sast-presek-card-sub">
          ${a.odgovoranLabel || a.odgovoranText ? '👤 ' + escHtml(a.odgovoranLabel || a.odgovoranText) : ''}
          ${a.rok || a.rokText ? ' · 📅 Rok: ' + escHtml(a.rokText || formatDate(a.rok)) : ''}
        </div>
        ${editable ? `
          <div class="sast-presek-card-actions">
            <button class="btn-icon" data-act="edit" title="Izmeni">✎</button>
            <button class="btn-icon btn-danger" data-act="delete" title="Obriši">🗑</button>
          </div>
        ` : ''}
      </header>
      <div class="sast-presek-content">
        ${a.sadrzajHtml || '<em style="color:var(--text2)">Bez opisa</em>'}
      </div>
      <div class="sast-presek-gallery">
        <div class="sast-presek-gallery-header">
          <strong>📷 Slike</strong>
          ${editable ? `
            <button class="btn-icon btn-primary" data-act="upload" title="Dodaj sliku">+ Slika</button>
            <input type="file" multiple accept="image/*,application/pdf" data-akt-upload="${a.id}" style="display:none">
          ` : ''}
        </div>
        <div class="sast-presek-gal">Učitavam…</div>
      </div>
    </article>
  `;
}

/* ── Aktivnost editor (rich-text) ── */

function openAktivnostEditor({ sast, editable, aktivnost = null, nextRb = 1, nextRedosled = 10, onSaved }) {
  const isEdit = !!aktivnost;
  const a = aktivnost || {
    id: null, sastanakId: sast.id,
    rb: nextRb, redosled: nextRedosled,
    naslov: '', podRn: '', sadrzajHtml: '',
    odgovoranEmail: '', odgovoranLabel: '', odgovoranText: '',
    rok: null, rokText: '',
    status: 'u_toku', napomena: '',
  };

  const overlay = document.createElement('div');
  overlay.className = 'sast-modal-overlay sast-modal-overlay-wide';
  overlay.style.zIndex = '20000';
  overlay.innerHTML = `
    <div class="sast-modal sast-modal-wide">
      <header class="sast-modal-header">
        <h3>${isEdit ? '✎ Izmeni aktivnost' : '+ Nova aktivnost'}</h3>
        <button class="sast-modal-close">✕</button>
      </header>
      <div class="sast-modal-body">
        <form id="aeForm" class="sast-form">
          <div class="sast-form-grid">
            <label class="sast-form-row">
              <span>RB *</span>
              <input type="number" name="rb" required value="${a.rb}" min="1">
            </label>
            <label class="sast-form-row">
              <span>Pod-RN</span>
              <input type="text" name="podRn" value="${escHtml(a.podRn || '')}" placeholder="9400/1">
            </label>
            <label class="sast-form-row">
              <span>Status</span>
              <select name="status">
                ${Object.entries(AKTIVNOST_STATUSI).map(([k, v]) => `<option value="${k}"${a.status === k ? ' selected' : ''}>${escHtml(v)}</option>`).join('')}
              </select>
            </label>
          </div>
          <label class="sast-form-row">
            <span>Naslov *</span>
            <input type="text" name="naslov" required maxlength="300" value="${escHtml(a.naslov)}" placeholder="RN 9400/1 - Presa za provlačenje 350 tona">
          </label>
          <label class="sast-form-row">
            <span>Sadržaj (rich text — opis aktivnosti, podsklopovi, status)</span>
            ${renderRichTextToolbar('aeEditor')}
            <div id="aeEditor" class="sast-rt-editor" contenteditable="true" data-placeholder="Opis aktivnosti...">${a.sadrzajHtml || ''}</div>
          </label>
          <div class="sast-form-grid">
            <label class="sast-form-row">
              <span>Odgovoran (slobodno)</span>
              <input type="text" name="odgovoranText" value="${escHtml(a.odgovoranText || '')}" placeholder="M. Stojadinović">
            </label>
            <label class="sast-form-row">
              <span>Rok (datum)</span>
              <input type="date" name="rok" value="${escHtml(a.rok || '')}">
            </label>
            <label class="sast-form-row">
              <span>Rok (slobodno)</span>
              <input type="text" name="rokText" value="${escHtml(a.rokText || '')}" placeholder="kraj aprila">
            </label>
          </div>
        </form>
      </div>
      <footer class="sast-modal-footer">
        <button class="btn" id="aeCancel">Otkaži</button>
        <button class="btn btn-primary" id="aeSave">${isEdit ? 'Sačuvaj izmene' : 'Kreiraj aktivnost'}</button>
      </footer>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('.sast-modal-close').addEventListener('click', close);
  overlay.querySelector('#aeCancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  /* Wire toolbar. */
  wireRichTextToolbar(overlay, 'aeEditor');

  overlay.querySelector('#aeSave').addEventListener('click', async () => {
    const fd = new FormData(overlay.querySelector('#aeForm'));
    const naslov = String(fd.get('naslov') || '').trim();
    if (!naslov) { showToast('⚠ Naslov je obavezan'); return; }
    const editorEl = overlay.querySelector('#aeEditor');
    const sadrzajHtml = sanitizeHtml(editorEl.innerHTML);

    const payload = {
      ...a,
      naslov,
      podRn: String(fd.get('podRn') || '').trim(),
      sadrzajHtml,
      odgovoranText: String(fd.get('odgovoranText') || '').trim(),
      rok: fd.get('rok') || null,
      rokText: String(fd.get('rokText') || '').trim(),
      status: fd.get('status') || 'u_toku',
      rb: Number(fd.get('rb')) || a.rb,
    };
    const r = await saveAktivnost(payload);
    if (r) {
      showToast(isEdit ? '✎ Aktivnost sačuvana' : '+ Aktivnost kreirana');
      close();
      onSaved?.(r);
    } else {
      showToast('⚠ Greška pri snimanju');
    }
  });
}

/* ── Rich text editor (native contenteditable) ── */

function renderRichTextToolbar(targetId) {
  return `
    <div class="sast-rt-toolbar" data-rt-toolbar="${targetId}">
      <button type="button" data-cmd="bold" title="Bold (Ctrl+B)"><b>B</b></button>
      <button type="button" data-cmd="italic" title="Italic (Ctrl+I)"><i>I</i></button>
      <button type="button" data-cmd="underline" title="Underline (Ctrl+U)"><u>U</u></button>
      <span class="sast-rt-sep"></span>
      <button type="button" data-cmd="insertUnorderedList" title="Lista">• Lista</button>
      <button type="button" data-cmd="insertOrderedList" title="Brojevi">1. Lista</button>
      <button type="button" data-cmd="indent" title="Indent">→</button>
      <button type="button" data-cmd="outdent" title="Outdent">←</button>
      <span class="sast-rt-sep"></span>
      <button type="button" data-cmd="formatBlock" data-arg="h4" title="Naslov">H</button>
      <button type="button" data-cmd="formatBlock" data-arg="p" title="Paragraf">P</button>
      <button type="button" data-cmd="removeFormat" title="Očisti format">✕ Format</button>
    </div>
  `;
}

function wireRichTextToolbar(root, targetId) {
  const toolbar = root.querySelector(`[data-rt-toolbar="${targetId}"]`);
  const editor = root.querySelector('#' + targetId);
  if (!toolbar || !editor) return;
  toolbar.querySelectorAll('button[data-cmd]').forEach(btn => {
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const cmd = btn.dataset.cmd;
      const arg = btn.dataset.arg || null;
      try {
        document.execCommand(cmd, false, arg);
      } catch (err) { /* noop */ }
      editor.focus();
    });
  });
}

/**
 * Minimum sanitizer — uklanja <script>, <iframe>, on* atribute, javascript: URL.
 * MVP nivo. Za produkciju koristiti DOMPurify.
 */
function sanitizeHtml(html) {
  if (!html) return '';
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html);
  const removeAll = (sel) => tpl.content.querySelectorAll(sel).forEach(el => el.remove());
  removeAll('script, iframe, object, embed, link, meta, style, form');
  tpl.content.querySelectorAll('*').forEach(el => {
    [...el.attributes].forEach(attr => {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(attr.name);
      if (name === 'href' || name === 'src') {
        if (/^javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
      }
    });
  });
  return tpl.innerHTML;
}

/* ── Image lightbox ── */

function openImageLightbox(src) {
  const overlay = document.createElement('div');
  overlay.className = 'sast-lightbox';
  overlay.style.zIndex = '30000';
  overlay.innerHTML = `<img src="${src}" alt=""><button class="sast-lightbox-close">✕</button>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', close);
  overlay.querySelector('.sast-lightbox-close').addEventListener('click', close);
}
