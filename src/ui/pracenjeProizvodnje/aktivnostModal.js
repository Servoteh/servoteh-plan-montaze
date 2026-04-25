import { escHtml, showToast } from '../../lib/dom.js';
import {
  blockAktivnost,
  closeAktivnost,
  saveAktivnost,
  unblockAktivnost,
} from '../../state/pracenjeProizvodnjeState.js';
import { fetchActivityHistory } from '../../services/pracenjeProizvodnje.js';

export function openAktivnostModal({ state, activity = null, onSaved } = {}) {
  if (!state?.canEdit && !activity) {
    showToast('Pregled — nema izmena');
    return;
  }
  const modal = document.createElement('div');
  modal.className = 'modal-overlay open';
  modal.id = 'aktivnostModal';
  modal.innerHTML = `
    <div class="modal-panel" role="dialog" aria-labelledby="aktivnostModalTitle" style="max-width:900px">
      <div class="modal-header">
        <h3 id="aktivnostModalTitle">${activity ? 'Operativna aktivnost' : 'Nova operativna aktivnost'} ${sourceBadgeHtml(activity)}</h3>
        <button type="button" class="modal-close" aria-label="Zatvori">×</button>
      </div>
      <div class="modal-body">
        ${activity ? '<nav class="kadrovska-tabs" style="margin-bottom:12px"><button type="button" class="kadrovska-tab is-active" data-oa-modal-tab="form">Detalji</button><button type="button" class="kadrovska-tab" data-oa-modal-tab="history">Istorija</button></nav>' : ''}
        <div id="oaModalForm">${formHtml(state, activity)}</div>
        <div id="oaModalHistory" style="display:none"></div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  wireModal(modal, state, activity, onSaved);
  attachOverlayClose(modal);
}

function formHtml(state, activity) {
  const a = activity || {};
  const readOnly = !state.canEdit;
  const selectedDeptId = a.odeljenje_id || findDeptIdByName(state, a.odeljenje || a.odeljenje_naziv);
  return `
    <div class="form-grid">
      <label>Odeljenje
        <select id="oaOdeljenje" ${readOnly ? 'disabled' : ''}>
          <option value="">Izaberi odeljenje…</option>
          ${(state.departments || []).map(d => `
            <option value="${escHtml(d.id)}"${d.id === selectedDeptId ? ' selected' : ''}>${escHtml(d.naziv || d.kod)}</option>
          `).join('')}
        </select>
      </label>
      <label>RB<input id="oaRb" type="number" min="1" value="${escHtml(a.rb ?? 100)}" ${readOnly ? 'disabled' : ''}></label>
      <label style="grid-column:1 / -1">Aktivnost<input id="oaNaziv" type="text" value="${escHtml(a.naziv_aktivnosti || '')}" ${readOnly ? 'disabled' : ''}></label>
      <label>Br. TP<input id="oaBrojTp" type="text" value="${escHtml(a.broj_tp || '')}" ${readOnly ? 'disabled' : ''}></label>
      <label>Količina<input id="oaKolicina" type="text" value="${escHtml(a.kolicina_text || '')}" ${readOnly ? 'disabled' : ''}></label>
      <label>Planirani početak<input id="oaPocetak" type="date" value="${escHtml(a.planirani_pocetak || '')}" ${readOnly ? 'disabled' : ''}></label>
      <label>Planirani završetak<input id="oaZavrsetak" type="date" value="${escHtml(a.planirani_zavrsetak || '')}" ${readOnly ? 'disabled' : ''}></label>
      <label>Odgovoran radnik
        <select id="oaRadnik" ${readOnly ? 'disabled' : ''}>
          <option value="">Bez veze na radnika</option>
          ${(state.radnici || []).map(r => `
            <option value="${escHtml(r.id)}"${r.id === a.odgovoran_radnik_id ? ' selected' : ''}>${escHtml(r.puno_ime || r.ime || r.email || r.id)}</option>
          `).join('')}
        </select>
      </label>
      <label>Odgovoran label<input id="oaOdgovoranLabel" type="text" value="${escHtml(a.odgovoran_label || a.odgovoran || '')}" ${readOnly ? 'disabled' : ''}></label>
      <label>Zavisi od aktivnosti
        <select id="oaZavisiId" ${readOnly ? 'disabled' : ''}>
          <option value="">Bez FK veze</option>
          ${(state.tab2Data?.activities || []).filter(x => x.id !== a.id).map(x => `
            <option value="${escHtml(x.id)}"${x.id === a.zavisi_od_aktivnost_id ? ' selected' : ''}>${escHtml(x.rb || '')} ${escHtml(x.naziv_aktivnosti || '')}</option>
          `).join('')}
        </select>
      </label>
      <label>Zavisi od tekst<input id="oaZavisiText" type="text" value="${escHtml(a.zavisi_od_text || a.zavisi_od || '')}" ${readOnly ? 'disabled' : ''}></label>
      <label>Status mode
        <select id="oaStatusMode" ${readOnly ? 'disabled' : ''}>
          ${option('manual', 'Ručno', a.status_mode || 'manual')}
          ${option('auto_from_pozicija', 'Auto iz pozicije', a.status_mode)}
          ${option('auto_from_operacije', 'Auto iz operacija', a.status_mode)}
        </select>
      </label>
      <label>Status (ručni)
        <select id="oaStatus" ${readOnly ? 'disabled' : ''}>
          ${option('nije_krenulo', 'Nije krenulo', a.status || a.efektivni_status)}
          ${option('u_toku', 'U toku', a.status || a.efektivni_status)}
          ${option('blokirano', 'Blokirano', a.status || a.efektivni_status)}
          ${option('zavrseno', 'Završeno', a.status || a.efektivni_status)}
        </select>
      </label>
      <label>Prioritet
        <select id="oaPrioritet" ${readOnly ? 'disabled' : ''}>
          ${option('nizak', 'Nizak', a.prioritet || 'srednji')}
          ${option('srednji', 'Srednji', a.prioritet || 'srednji')}
          ${option('visok', 'Visok', a.prioritet || 'srednji')}
        </select>
      </label>
      <label style="grid-column:1 / -1">Rizik / napomena<textarea id="oaRizik" rows="3" ${readOnly ? 'disabled' : ''}>${escHtml(a.rizik_napomena || '')}</textarea></label>
    </div>
    <div class="form-actions" style="justify-content:space-between">
      <div>
        ${state.canEdit ? `<button type="button" class="btn btn-primary" id="oaSaveBtn">Sačuvaj</button>` : '<span class="form-hint">Read-only prikaz</span>'}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${state.canEdit && activity ? '<button type="button" class="btn btn-ghost" id="oaCloseBtn">Zatvori aktivnost</button>' : ''}
        ${state.canEdit && activity ? blockButtonHtml(activity) : ''}
      </div>
    </div>
  `;
}

function wireModal(modal, state, activity, onSaved) {
  modal.querySelector('.modal-close')?.addEventListener('click', () => close(modal));
  modal.querySelector('#oaSaveBtn')?.addEventListener('click', async () => {
    const payload = collectPayload(modal, state, activity);
    if (!payload.odeljenje_id) { showToast('Odeljenje je obavezno'); return; }
    if (!payload.naziv_aktivnosti.trim()) { showToast('Naziv aktivnosti je obavezan'); return; }
    const ok = await saveAktivnost(payload);
    if (ok) {
      showToast('Aktivnost sačuvana');
      close(modal);
      onSaved?.();
    }
  });
  modal.querySelector('#oaCloseBtn')?.addEventListener('click', async () => {
    const napomena = prompt('Napomena za zatvaranje aktivnosti:', '') || '';
    const ok = await closeAktivnost(activity.id, napomena);
    if (ok) {
      showToast('Aktivnost zatvorena');
      close(modal);
      onSaved?.();
    }
  });
  modal.querySelector('#oaBlockBtn')?.addEventListener('click', async () => {
    const razlog = prompt('Razlog blokade (obavezno):', activity?.blokirano_razlog || '') || '';
    if (!razlog.trim()) { showToast('Razlog blokade je obavezan'); return; }
    const ok = await blockAktivnost(activity.id, razlog);
    if (ok) {
      showToast('Aktivnost blokirana');
      close(modal);
      onSaved?.();
    }
  });
  modal.querySelector('#oaUnblockBtn')?.addEventListener('click', async () => {
    const napomena = prompt('Napomena za skidanje blokade:', '') || '';
    const ok = await unblockAktivnost(activity.id, napomena);
    if (ok) {
      showToast('Blokada skinuta');
      close(modal);
      onSaved?.();
    }
  });
  modal.querySelectorAll('[data-oa-modal-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.oaModalTab;
      modal.querySelectorAll('[data-oa-modal-tab]').forEach(b => b.classList.toggle('is-active', b === btn));
      modal.querySelector('#oaModalForm').style.display = tab === 'form' ? '' : 'none';
      modal.querySelector('#oaModalHistory').style.display = tab === 'history' ? '' : 'none';
      if (tab === 'history') loadHistory(modal, activity);
    });
  });
  modal.querySelector('#oaMeetingLink')?.addEventListener('click', () => {
    if (!activity?.izvor_akcioni_plan_id) return;
    const path = `/sastanci?akcija=${encodeURIComponent(activity.izvor_akcioni_plan_id)}`;
    history.pushState(null, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
}

async function loadHistory(modal, activity) {
  const host = modal.querySelector('#oaModalHistory');
  if (!host || !activity?.id) return;
  host.innerHTML = '<div class="pp-state"><div class="pp-state-title">Učitavanje istorije…</div></div>';
  try {
    const history = await fetchActivityHistory(activity.id);
    host.innerHTML = historyHtml(history);
  } catch (e) {
    host.innerHTML = `<div class="pp-error">${escHtml(e?.message || e)}</div>`;
  }
}

function historyHtml(history) {
  const blokade = history.blokade || [];
  const audit = history.audit || [];
  return `
    <div class="form-section-title">Istorija blokada</div>
    ${blokade.length ? tableHistory(blokade.map(r => ({
      kada: r.created_at,
      ko: r.changed_by_email || r.changed_by || '—',
      sta: `blokada: ${r.old_manual_override_status || '—'} → ${r.new_manual_override_status || '—'}`,
      napomena: r.new_blokirano_razlog || r.napomena || '',
    }))) : '<div class="form-hint">Nema zapisa blokade.</div>'}
    <div class="form-section-title" style="margin-top:14px">Audit izmene</div>
    ${audit.length ? tableHistory(audit.map(r => ({
      kada: r.changed_at,
      ko: r.actor_email || r.actor_uid || '—',
      sta: `${r.action || ''}: ${(r.diff_keys || []).join(', ')}`,
      napomena: formatDiff(r),
    }))) : '<div class="form-hint">Audit log nije dostupan ili nema zapisa.</div>'}
  `;
}

function tableHistory(rows) {
  return `
    <div class="pp-table-wrap"><table class="pp-table">
      <thead><tr><th>Kada</th><th>Ko</th><th>Šta</th><th>Napomena</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td>${escHtml(formatDate(r.kada))}</td><td>${escHtml(r.ko)}</td><td>${escHtml(r.sta)}</td><td>${escHtml(r.napomena)}</td></tr>`).join('')}</tbody>
    </table></div>
  `;
}

function formatDiff(row) {
  const keys = row.diff_keys || [];
  return keys.map(k => `${k}: ${row.old_data?.[k] ?? '—'} → ${row.new_data?.[k] ?? '—'}`).join('; ');
}

function sourceBadgeHtml(activity) {
  if (!activity || activity.izvor !== 'iz_sastanka') return '';
  return `<button type="button" class="pp-status s-in_progress" id="oaMeetingLink" title="Otvori akcionu tačku">↔ Iz sastanka</button>`;
}

function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString('sr-RS');
}

function collectPayload(modal, state, activity) {
  return {
    id: activity?.id || null,
    radni_nalog_id: state.rnId,
    projekat_id: state.header?.projekat_id || null,
    odeljenje_id: modal.querySelector('#oaOdeljenje')?.value || null,
    rb: Number(modal.querySelector('#oaRb')?.value || 100),
    naziv_aktivnosti: modal.querySelector('#oaNaziv')?.value || '',
    broj_tp: modal.querySelector('#oaBrojTp')?.value || null,
    kolicina_text: modal.querySelector('#oaKolicina')?.value || null,
    planirani_pocetak: modal.querySelector('#oaPocetak')?.value || null,
    planirani_zavrsetak: modal.querySelector('#oaZavrsetak')?.value || null,
    odgovoran_radnik_id: modal.querySelector('#oaRadnik')?.value || null,
    odgovoran_label: modal.querySelector('#oaOdgovoranLabel')?.value || null,
    zavisi_od_aktivnost_id: modal.querySelector('#oaZavisiId')?.value || null,
    zavisi_od_text: modal.querySelector('#oaZavisiText')?.value || null,
    status_mode: modal.querySelector('#oaStatusMode')?.value || 'manual',
    status: modal.querySelector('#oaStatus')?.value || 'nije_krenulo',
    prioritet: modal.querySelector('#oaPrioritet')?.value || 'srednji',
    rizik_napomena: modal.querySelector('#oaRizik')?.value || null,
    izvor: activity?.izvor || 'rucno',
  };
}

function blockButtonHtml(activity) {
  if ((activity.efektivni_status || activity.manual_override_status) === 'blokirano') {
    return '<button type="button" class="btn btn-ghost" id="oaUnblockBtn">Skini blokadu</button>';
  }
  return '<button type="button" class="btn btn-ghost" id="oaBlockBtn">Postavi blokirano</button>';
}

function option(value, label, selected) {
  return `<option value="${escHtml(value)}"${value === selected ? ' selected' : ''}>${escHtml(label)}</option>`;
}

function findDeptIdByName(state, name) {
  if (!name) return null;
  const d = (state.departments || []).find(x => String(x.naziv) === String(name));
  return d?.id || null;
}

function attachOverlayClose(modal) {
  modal.addEventListener('click', (ev) => {
    if (ev.target === modal) close(modal);
  });
  const onEsc = (ev) => {
    if (ev.key === 'Escape') {
      close(modal);
      window.removeEventListener('keydown', onEsc);
    }
  };
  window.addEventListener('keydown', onEsc);
}

function close(modal) {
  modal?.remove();
}
