/**
 * Sastanak modal — pregled / vođenje pojedinačnog sastanka.
 *
 * Razgranava se po tipu:
 *   - 'sedmicni'  → meta + učesnici + dnevni red (PM teme) + akcioni plan
 *   - 'projektni' → meta + učesnici + presek aktivnosti (rich text + slike)
 *                   (S2 sloj — videti projektniContent.js)
 *
 * Status workflow:
 *   planiran → u_toku (klik "▶ Započni sastanak")
 *   u_toku   → zavrsen (klik "⏹ Završi")
 *   zavrsen  → zakljucan (klik "🔒 Zaključaj i arhiviraj")
 *
 * Kad je status='zakljucan', sve forme su disabled (read-only) i prikazuje
 * se badge "Arhivirano".
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { formatDate } from '../../lib/date.js';
import {
  loadSastanak, loadUcesnici, saveSastanak, saveUcesnici,
  updateSastanakStatus, updateUcesnikPrisustvo,
  SASTANAK_STATUSI, SASTANAK_STATUS_BOJE,
} from '../../services/sastanci.js';
import { loadPmTeme, dodeliTemuSastanku, saveTema } from '../../services/pmTeme.js';
import { loadAkcije, saveAkcija, updateAkcijaStatus, deleteAkcija, AKCIJA_STATUSI, AKCIJA_STATUS_BOJE } from '../../services/akcioniPlan.js';
import { arhivirajSastanak, loadArhiva, printZapisnik } from '../../services/sastanakArhiva.js';
import { loadProjekat } from '../../services/projekti.js';
import { getCurrentUser } from '../../state/auth.js';
import { renderProjektniContent } from './projektniContent.js';

let activeOverlay = null;

export async function openSastanakModal({ sastanakId, canEdit, onClose }) {
  /* Ako je već neki modal otvoren, zatvori ga. */
  if (activeOverlay) { activeOverlay.remove(); activeOverlay = null; }

  const overlay = document.createElement('div');
  overlay.className = 'sast-modal-overlay sast-modal-overlay-wide';
  overlay.innerHTML = `
    <div class="sast-modal sast-modal-wide">
      <div class="sast-modal-loading">Učitavam sastanak…</div>
    </div>
  `;
  document.body.appendChild(overlay);
  activeOverlay = overlay;

  const close = () => {
    overlay.remove();
    activeOverlay = null;
    onClose?.();
  };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const sast = await loadSastanak(sastanakId);
  if (!sast) {
    overlay.querySelector('.sast-modal').innerHTML = `
      <header class="sast-modal-header"><h3>Greška</h3><button class="sast-modal-close">✕</button></header>
      <div class="sast-modal-body"><div class="sast-empty">Sastanak nije pronađen.</div></div>
    `;
    overlay.querySelector('.sast-modal-close').addEventListener('click', close);
    return;
  }

  await renderSastanak(overlay, sast, { canEdit, onClose: close });
}

async function renderSastanak(overlay, sast, { canEdit, onClose }) {
  const isLocked = sast.status === 'zakljucan';
  const editable = canEdit && !isLocked;

  /* Učitaj sve relacije. */
  const [ucesnici, projekat, arhiva] = await Promise.all([
    loadUcesnici(sast.id),
    sast.projekatId ? loadProjekat(sast.projekatId) : Promise.resolve(null),
    isLocked ? loadArhiva(sast.id) : Promise.resolve(null),
  ]);

  const statusColor = SASTANAK_STATUS_BOJE[sast.status] || '#666';

  overlay.querySelector('.sast-modal').innerHTML = `
    <header class="sast-modal-header sast-modal-header-rich">
      <div class="sast-mh-left">
        <div class="sast-mh-tip">
          <span class="sast-tip-badge sast-tip-${escHtml(sast.tip)}">${sast.tip === 'projektni' ? 'Projektni' : 'Sedmični'}</span>
          <span class="sast-status-pill" style="background:${statusColor}">${escHtml(SASTANAK_STATUSI[sast.status])}</span>
          ${isLocked ? '<span class="sast-lock-badge">🔒 Arhivirano</span>' : ''}
        </div>
        <h2 class="sast-mh-title">${escHtml(sast.naslov)}</h2>
        <div class="sast-mh-meta">
          📅 ${escHtml(formatDate(sast.datum))}${sast.vreme ? ' · ' + escHtml(sast.vreme.slice(0, 5)) : ''}
          ${sast.mesto ? ' · 📍 ' + escHtml(sast.mesto) : ''}
          ${projekat ? ' · 🏗 ' + escHtml(projekat.label) : ''}
        </div>
      </div>
      <div class="sast-mh-right">
        ${renderStatusActions(sast, editable)}
        <button class="sast-modal-close" aria-label="Zatvori">✕</button>
      </div>
    </header>

    <div class="sast-modal-body sast-modal-body-tabs">
      <nav class="sast-inner-tabs" id="sastInnerTabs">
        <button class="sast-inner-tab is-active" data-itab="meta">📝 Meta</button>
        <button class="sast-inner-tab" data-itab="ucesnici">👥 Učesnici (${ucesnici.length})</button>
        ${sast.tip === 'sedmicni' ? '<button class="sast-inner-tab" data-itab="dnevni-red">📋 Dnevni red</button>' : ''}
        ${sast.tip === 'projektni' ? '<button class="sast-inner-tab" data-itab="presek">🏗 Presek stanja</button>' : ''}
        <button class="sast-inner-tab" data-itab="akcije">✅ Akcioni plan</button>
        ${arhiva ? '<button class="sast-inner-tab" data-itab="zapisnik">📄 Zapisnik</button>' : ''}
      </nav>
      <div class="sast-inner-tabbody" id="sastInnerBody"></div>
    </div>
  `;

  overlay.querySelector('.sast-modal-close').addEventListener('click', onClose);

  /* Inner tab handler. */
  const tabBody = overlay.querySelector('#sastInnerBody');
  let activeITab = 'meta';
  const renderITab = async () => {
    if (activeITab === 'meta') renderMetaPanel(tabBody, sast, projekat, { editable });
    if (activeITab === 'ucesnici') renderUcesniciPanel(tabBody, sast, ucesnici, { editable });
    if (activeITab === 'dnevni-red') await renderDnevniRedPanel(tabBody, sast, { editable });
    if (activeITab === 'presek') await renderProjektniContent(tabBody, sast, { editable });
    if (activeITab === 'akcije') await renderAkcijePanel(tabBody, sast, { editable });
    if (activeITab === 'zapisnik') renderZapisnikPanel(tabBody, arhiva);
  };
  await renderITab();

  overlay.querySelectorAll('[data-itab]').forEach(b => {
    b.addEventListener('click', async () => {
      overlay.querySelectorAll('[data-itab]').forEach(x => x.classList.remove('is-active'));
      b.classList.add('is-active');
      activeITab = b.dataset.itab;
      await renderITab();
    });
  });

  /* Status action handlers. */
  overlay.querySelectorAll('[data-status-action]').forEach(b => {
    b.addEventListener('click', async () => {
      const act = b.dataset.statusAction;
      if (act === 'start') {
        const r = await updateSastanakStatus(sast.id, 'u_toku');
        if (r) { showToast('▶ Sastanak započet'); await renderSastanak(overlay, r, { canEdit, onClose }); }
        return;
      }
      if (act === 'complete') {
        const r = await updateSastanakStatus(sast.id, 'zavrsen');
        if (r) { showToast('⏹ Sastanak završen'); await renderSastanak(overlay, r, { canEdit, onClose }); }
        return;
      }
      if (act === 'archive') {
        if (!confirm('Zaključaj i arhiviraj sastanak? Posle ovog koraka sve postaje read-only.')) return;
        const res = await arhivirajSastanak(sast.id);
        if (res.ok) {
          showToast('🔒 Sastanak arhiviran');
          const updated = await loadSastanak(sast.id);
          await renderSastanak(overlay, updated, { canEdit, onClose });
        } else {
          showToast('⚠ ' + (res.error || 'Greška pri arhiviranju'));
        }
        return;
      }
      if (act === 'print') {
        const arh = arhiva || await loadArhiva(sast.id);
        if (arh && arh.snapshot) {
          printZapisnik(arh.snapshot);
        } else {
          showToast('ℹ Nema arhiviranih podataka. Najpre arhiviraj sastanak.');
        }
      }
    });
  });
}

function renderStatusActions(sast, editable) {
  if (!editable && sast.status !== 'zakljucan') return '';
  const btns = [];
  if (editable && sast.status === 'planiran') {
    btns.push('<button class="btn btn-primary btn-sm" data-status-action="start">▶ Započni</button>');
  }
  if (editable && sast.status === 'u_toku') {
    btns.push('<button class="btn btn-primary btn-sm" data-status-action="complete">⏹ Završi</button>');
  }
  if (editable && sast.status === 'zavrsen') {
    btns.push('<button class="btn btn-danger btn-sm" data-status-action="archive">🔒 Zaključaj i arhiviraj</button>');
  }
  if (sast.status === 'zakljucan') {
    btns.push('<button class="btn btn-sm" data-status-action="print">🖨 Štampaj zapisnik</button>');
  }
  return btns.join(' ');
}

/* ── Inner panels ── */

function renderMetaPanel(host, sast, projekat, { editable }) {
  host.innerHTML = `
    <form id="metaForm" class="sast-form">
      <div class="sast-form-grid">
        <label class="sast-form-row">
          <span>Naslov</span>
          <input type="text" name="naslov" value="${escHtml(sast.naslov)}" ${editable ? '' : 'disabled'}>
        </label>
        <label class="sast-form-row">
          <span>Datum</span>
          <input type="date" name="datum" value="${escHtml(sast.datum || '')}" ${editable ? '' : 'disabled'}>
        </label>
        <label class="sast-form-row">
          <span>Vreme</span>
          <input type="time" name="vreme" value="${escHtml(sast.vreme || '')}" ${editable ? '' : 'disabled'}>
        </label>
        <label class="sast-form-row">
          <span>Mesto</span>
          <input type="text" name="mesto" value="${escHtml(sast.mesto || '')}" ${editable ? '' : 'disabled'}>
        </label>
        <label class="sast-form-row">
          <span>Vodi sastanak</span>
          <input type="text" name="vodioLabel" value="${escHtml(sast.vodioLabel || '')}" ${editable ? '' : 'disabled'}>
        </label>
        <label class="sast-form-row">
          <span>Zapisničar</span>
          <input type="text" name="zapisnicarLabel" value="${escHtml(sast.zapisnicarLabel || '')}" ${editable ? '' : 'disabled'}>
        </label>
      </div>
      ${projekat ? `<div class="sast-info-row">🏗 <strong>Projekat:</strong> ${escHtml(projekat.label)}</div>` : ''}
      <label class="sast-form-row">
        <span>Napomena</span>
        <textarea name="napomena" rows="3" ${editable ? '' : 'disabled'}>${escHtml(sast.napomena || '')}</textarea>
      </label>
      ${editable ? '<div style="margin-top:12px"><button type="button" class="btn btn-primary" id="metaSave">💾 Sačuvaj meta podatke</button></div>' : ''}
    </form>
  `;

  if (editable) {
    host.querySelector('#metaSave').addEventListener('click', async () => {
      const fd = new FormData(host.querySelector('#metaForm'));
      const updated = {
        ...sast,
        naslov: String(fd.get('naslov') || sast.naslov).trim(),
        datum: fd.get('datum') || sast.datum,
        vreme: fd.get('vreme') || null,
        mesto: String(fd.get('mesto') || '').trim(),
        vodioLabel: String(fd.get('vodioLabel') || '').trim(),
        zapisnicarLabel: String(fd.get('zapisnicarLabel') || '').trim(),
        napomena: String(fd.get('napomena') || '').trim(),
      };
      const r = await saveSastanak(updated);
      if (r) showToast('💾 Meta podaci sačuvani');
      else showToast('⚠ Greška pri snimanju');
    });
  }
}

function renderUcesniciPanel(host, sast, ucesnici, { editable }) {
  host.innerHTML = `
    <div class="sast-section">
      <p style="margin:0 0 12px;color:var(--text2)">Lista učesnika sa označavanjem prisustva.</p>
      ${editable ? `
        <div class="sast-add-row">
          <input type="text" id="ucEmail" class="sast-input" placeholder="email@servoteh.com">
          <input type="text" id="ucLabel" class="sast-input" placeholder="Ime Prezime (display)">
          <button class="btn btn-primary" id="ucAddBtn">+ Dodaj</button>
        </div>
      ` : ''}
      <div id="ucList" class="sast-ucesnici-list"></div>
    </div>
  `;

  function renderList() {
    host.querySelector('#ucList').innerHTML = ucesnici.length === 0
      ? '<div class="sast-empty">Nema učesnika.</div>'
      : `<table class="sast-table"><thead><tr>
          <th>Prisutan</th><th>Ime</th><th>Email</th>${editable ? '<th class="sast-th-actions">Akcije</th>' : ''}
        </tr></thead><tbody>
          ${ucesnici.map(u => `
            <tr data-email="${escHtml(u.email)}">
              <td><input type="checkbox" class="ucPris" ${u.prisutan ? 'checked' : ''} ${editable ? '' : 'disabled'}></td>
              <td>${escHtml(u.label || '—')}</td>
              <td><small>${escHtml(u.email)}</small></td>
              ${editable ? `<td class="sast-td-actions"><button class="btn-icon btn-danger" data-action="remove">🗑</button></td>` : ''}
            </tr>
          `).join('')}
        </tbody></table>`;

    host.querySelectorAll('.ucPris').forEach(cb => {
      cb.addEventListener('change', async () => {
        const email = cb.closest('tr').dataset.email;
        const ok = await updateUcesnikPrisustvo(sast.id, email, cb.checked);
        if (ok) {
          const u = ucesnici.find(x => x.email === email);
          if (u) u.prisutan = cb.checked;
        } else {
          cb.checked = !cb.checked;
          showToast('⚠ Greška pri snimanju');
        }
      });
    });

    host.querySelectorAll('[data-action=remove]').forEach(b => {
      b.addEventListener('click', async () => {
        const email = b.closest('tr').dataset.email;
        const idx = ucesnici.findIndex(u => u.email === email);
        if (idx >= 0) ucesnici.splice(idx, 1);
        await saveUcesnici(sast.id, ucesnici);
        renderList();
      });
    });
  }
  renderList();

  if (editable) {
    host.querySelector('#ucAddBtn').addEventListener('click', async () => {
      const email = String(host.querySelector('#ucEmail').value || '').toLowerCase().trim();
      const label = String(host.querySelector('#ucLabel').value || '').trim();
      if (!email) { showToast('⚠ Unesi email'); return; }
      if (ucesnici.find(u => u.email === email)) { showToast('ℹ Učesnik već postoji'); return; }
      ucesnici.push({ email, label: label || email, prisutan: true, pozvan: true });
      const ok = await saveUcesnici(sast.id, ucesnici);
      if (ok) {
        host.querySelector('#ucEmail').value = '';
        host.querySelector('#ucLabel').value = '';
        renderList();
      }
    });
  }
}

async function renderDnevniRedPanel(host, sast, { editable }) {
  host.innerHTML = '<div class="sast-loading">Učitavam teme…</div>';
  /* Sve usvojene teme dodeljene ovom sastanku + sve teme bez sastanka koje
     mogu da se pridruže. */
  const [dodeljene, slobodne] = await Promise.all([
    loadPmTeme({ sastanakId: sast.id, limit: 200 }),
    editable ? loadPmTeme({ status: 'usvojeno', limit: 200 }) : Promise.resolve([]),
  ]);
  const slobodneFiltered = slobodne.filter(t => !t.sastanakId);

  host.innerHTML = `
    <div class="sast-section">
      <h4>Dnevni red (${dodeljene.length})</h4>
      ${dodeljene.length === 0 ? '<div class="sast-empty">Nema tema u dnevnom redu.</div>' : `
        <ol class="sast-agenda">
          ${dodeljene.map(t => `
            <li class="sast-agenda-item">
              <div class="sast-agenda-main">
                <div class="sast-agenda-title">${escHtml(t.naslov)}</div>
                ${t.opis ? `<div class="sast-agenda-desc">${escHtml(t.opis)}</div>` : ''}
                <div class="sast-agenda-meta">${escHtml(t.predlozioLabel || t.predlozioEmail)} · ${escHtml(t.oblast)} · prioritet ${t.prioritet}</div>
              </div>
              ${editable ? `
                <div class="sast-agenda-actions">
                  <button class="btn-icon btn-success" data-tema="${t.id}" data-action="resi">✓ Reši</button>
                </div>
              ` : ''}
            </li>
          `).join('')}
        </ol>
      `}
      ${editable && slobodneFiltered.length > 0 ? `
        <h4 style="margin-top:24px">Pridruži usvojene teme:</h4>
        <div class="sast-free-themes">
          ${slobodneFiltered.map(t => `
            <button class="sast-free-tema-btn" data-add-tema="${t.id}">
              + ${escHtml(t.naslov)}
            </button>
          `).join('')}
        </div>
      ` : ''}
    </div>
  `;

  if (editable) {
    host.querySelectorAll('[data-add-tema]').forEach(b => {
      b.addEventListener('click', async () => {
        const r = await dodeliTemuSastanku(b.dataset.addTema, sast.id);
        if (r) { showToast('+ Tema dodata'); await renderDnevniRedPanel(host, sast, { editable }); }
      });
    });
    host.querySelectorAll('[data-action=resi]').forEach(b => {
      b.addEventListener('click', async () => {
        const tema = dodeljene.find(t => t.id === b.dataset.tema);
        if (!tema) return;
        const r = await saveTema({ ...tema, status: 'zatvoreno' });
        if (r) { showToast('✓ Tema rešena'); await renderDnevniRedPanel(host, sast, { editable }); }
      });
    });
  }
}

async function renderAkcijePanel(host, sast, { editable }) {
  host.innerHTML = '<div class="sast-loading">Učitavam akcioni plan…</div>';
  let akcije = await loadAkcije({ sastanakId: sast.id, limit: 500 });

  host.innerHTML = `
    <div class="sast-section">
      <div class="sast-toolbar" style="margin-bottom:12px">
        <h4 style="margin:0">Akcioni plan (${akcije.length})</h4>
        ${editable ? '<button class="btn btn-primary btn-sm" id="addAkcijaBtn">+ Nova akcija</button>' : ''}
      </div>
      <div id="apList"></div>
    </div>
  `;

  function renderList() {
    host.querySelector('#apList').innerHTML = akcije.length === 0
      ? '<div class="sast-empty">Nema akcija.</div>'
      : `<table class="sast-table"><thead><tr>
          <th>Status</th><th>Naslov</th><th>Odgovoran</th><th>Rok</th>${editable ? '<th class="sast-th-actions">Akcije</th>' : ''}
        </tr></thead><tbody>
        ${akcije.map(a => {
          const eff = a.effectiveStatus || a.status;
          const c = AKCIJA_STATUS_BOJE[eff] || '#666';
          return `<tr data-id="${a.id}">
            <td><span class="sast-status-pill" style="background:${c}">${escHtml(AKCIJA_STATUSI[eff] || eff)}</span></td>
            <td><strong>${escHtml(a.naslov)}</strong>${a.opis ? `<br><small>${escHtml(a.opis)}</small>` : ''}</td>
            <td>${escHtml(a.odgovoranLabel || a.odgovoranText || a.odgovoranEmail || '—')}</td>
            <td>${escHtml(a.rokText || formatDate(a.rok) || '—')}</td>
            ${editable ? `<td class="sast-td-actions">
              ${eff !== 'zavrsen' ? `<button class="btn-icon btn-success" data-aaction="complete" title="Završi">✓</button>` : ''}
              <button class="btn-icon btn-danger" data-aaction="delete" title="Obriši">🗑</button>
            </td>` : ''}
          </tr>`;
        }).join('')}
        </tbody></table>`;

    if (!editable) return;
    host.querySelectorAll('[data-aaction]').forEach(b => {
      b.addEventListener('click', async () => {
        const id = b.closest('tr').dataset.id;
        const act = b.dataset.aaction;
        if (act === 'complete') {
          const r = await updateAkcijaStatus(id, 'zavrsen', '');
          if (r) {
            akcije = akcije.map(x => x.id === id ? r : x);
            renderList();
          }
        }
        if (act === 'delete') {
          if (!confirm('Obriši akciju?')) return;
          const ok = await deleteAkcija(id);
          if (ok) {
            akcije = akcije.filter(x => x.id !== id);
            renderList();
          }
        }
      });
    });
  }
  renderList();

  if (editable) {
    host.querySelector('#addAkcijaBtn').addEventListener('click', () => {
      openInlineAkcijaForm(host, sast, async (newA) => {
        const r = await saveAkcija(newA);
        if (r) {
          akcije.unshift(r);
          renderList();
          showToast('+ Akcija kreirana');
        }
      });
    });
  }
}

function openInlineAkcijaForm(host, sast, onSave) {
  const overlay = document.createElement('div');
  overlay.className = 'sast-modal-overlay';
  overlay.style.zIndex = '20000';
  overlay.innerHTML = `
    <div class="sast-modal">
      <header class="sast-modal-header"><h3>+ Nova akcija</h3><button class="sast-modal-close">✕</button></header>
      <div class="sast-modal-body">
        <form id="inAp" class="sast-form">
          <label class="sast-form-row"><span>Naslov *</span><input type="text" name="naslov" required maxlength="200"></label>
          <label class="sast-form-row"><span>Opis</span><textarea name="opis" rows="2"></textarea></label>
          <div class="sast-form-grid">
            <label class="sast-form-row"><span>Odgovoran (email)</span><input type="text" name="odgovoranEmail" placeholder="ime@servoteh.com"></label>
            <label class="sast-form-row"><span>Odgovoran (slobodno)</span><input type="text" name="odgovoranText"></label>
            <label class="sast-form-row"><span>Rok</span><input type="date" name="rok"></label>
            <label class="sast-form-row"><span>Prioritet</span>
              <select name="prioritet"><option value="1">🔴 Visok</option><option value="2" selected>🟡 Srednji</option><option value="3">🟢 Nizak</option></select>
            </label>
          </div>
        </form>
      </div>
      <footer class="sast-modal-footer">
        <button class="btn" id="inApCancel">Otkaži</button>
        <button class="btn btn-primary" id="inApSave">Kreiraj</button>
      </footer>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('.sast-modal-close').addEventListener('click', close);
  overlay.querySelector('#inApCancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#inApSave').addEventListener('click', async () => {
    const fd = new FormData(overlay.querySelector('#inAp'));
    const naslov = String(fd.get('naslov') || '').trim();
    if (!naslov) { showToast('⚠ Naslov je obavezan'); return; }
    await onSave({
      sastanakId: sast.id,
      projekatId: sast.projekatId || null,
      naslov,
      opis: fd.get('opis'),
      odgovoranEmail: fd.get('odgovoranEmail'),
      odgovoranText: fd.get('odgovoranText'),
      rok: fd.get('rok') || null,
      prioritet: Number(fd.get('prioritet')) || 2,
      status: 'otvoren',
    });
    close();
  });
}

function renderZapisnikPanel(host, arhiva) {
  if (!arhiva || !arhiva.snapshot) {
    host.innerHTML = '<div class="sast-empty">Nema arhiviranog zapisnika.</div>';
    return;
  }
  const snap = arhiva.snapshot;
  host.innerHTML = `
    <div class="sast-section">
      <div class="sast-info-row">
        🔒 Arhivirano: ${escHtml(formatDate(arhiva.arhiviranoAt))} ·
        ${escHtml(arhiva.arhiviraoLabel || arhiva.arhiviraoEmail || '—')} ·
        Schema v${snap.schemaVersion || 1}
      </div>
      <div style="margin:12px 0">
        <button class="btn btn-primary" id="zapPrintBtn">🖨 Otvori zapisnik za štampu / PDF</button>
      </div>
      <details style="margin-top:16px">
        <summary>JSON snapshot (debug)</summary>
        <pre style="max-height:400px;overflow:auto;background:var(--surface3,#222);padding:12px;border-radius:6px;font-size:11px">${escHtml(JSON.stringify(snap, null, 2))}</pre>
      </details>
    </div>
  `;
  host.querySelector('#zapPrintBtn').addEventListener('click', () => printZapisnik(snap));
}
