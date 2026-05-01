/**
 * Projektni biro — Supabase servis (pb_tasks, pb_work_reports, load stats).
 */

import { sbReqThrow } from './supabase.js';
import { SUPABASE_CONFIG, hasSupabaseConfig } from '../lib/constants.js';
import { getCurrentUser, getIsOnline } from '../state/auth.js';

/** @returns {string|null} */
function actorEmail() {
  const u = getCurrentUser();
  return u?.email ? String(u.email) : null;
}

/**
 * @param {object} data
 * @param {boolean} partial - true za PATCH (samo prisutna polja)
 */
function assertValidTaskInput(data, partial) {
  if (!partial) {
    if (!data.naziv || !String(data.naziv).trim()) {
      const e = new Error('Naziv zadatka je obavezan');
      e.code = 'VALIDATION';
      throw e;
    }
  } else if (Object.prototype.hasOwnProperty.call(data, 'naziv')) {
    if (data.naziv != null && !String(data.naziv).trim()) {
      const e = new Error('Naziv zadatka ne sme biti prazan');
      e.code = 'VALIDATION';
      throw e;
    }
  }
  if (data.procenat_zavrsenosti !== undefined && data.procenat_zavrsenosti !== null) {
    const pct = Number(data.procenat_zavrsenosti);
    if (Number.isNaN(pct) || pct < 0 || pct > 100) {
      const e = new Error('Procenat završenosti mora biti između 0 i 100');
      e.code = 'VALIDATION';
      throw e;
    }
  }
  if (data.norma_sati_dan !== undefined && data.norma_sati_dan !== null) {
    const h = Number(data.norma_sati_dan);
    if (Number.isNaN(h) || h < 1 || h > 7) {
      const e = new Error('Norma mora biti između 1 i 7 sati/dan');
      e.code = 'VALIDATION';
      throw e;
    }
  }
  const dp = data.datum_pocetka_plan;
  const dr = data.datum_zavrsetka_plan;
  if (dp && dr && String(dr).slice(0, 10) < String(dp).slice(0, 10)) {
    const e = new Error('Planirani rok ne može biti pre datuma početka');
    e.code = 'VALIDATION';
    throw e;
  }
  const rp = data.datum_pocetka_real;
  const rz = data.datum_zavrsetka_real;
  if (rp && rz && String(rz).slice(0, 10) < String(rp).slice(0, 10)) {
    const e = new Error('Realni završetak ne može biti pre realnog početka');
    e.code = 'VALIDATION';
    throw e;
  }
}

/**
 * Aktivni projekti za dropdown (isti kriterijum kao loadProjektiLite — ne arhivirani).
 */
export async function getPbProjects() {
  if (!getIsOnline()) return [];
  const url =
    'projects?select=id,project_code,project_name,status'
    + '&status=neq.archived'
    + '&order=project_code.asc.nullslast,project_name.asc';
  const data = await sbReqThrow(url);
  return Array.isArray(data) ? data : [];
}

/**
 * Aktivni zaposleni za filter / dodelu.
 */
export async function getPbEngineers() {
  if (!getIsOnline()) return [];
  const url =
    'employees?select=id,full_name,department,email'
    + '&is_active=eq.true'
    + '&order=full_name.asc';
  const data = await sbReqThrow(url);
  return Array.isArray(data) ? data : [];
}

/**
 * @param {{ projectId?: string|null, employeeId?: string|null, status?: string|null }} filters
 */
export async function getPbTasks(filters = {}) {
  if (!getIsOnline()) return [];
  let url =
    'pb_tasks?select=*,projects(project_code,project_name),employees(full_name)'
    + '&deleted_at=is.null';
  const { projectId, employeeId, status } = filters;
  if (projectId) url += `&project_id=eq.${encodeURIComponent(projectId)}`;
  if (employeeId) url += `&employee_id=eq.${encodeURIComponent(employeeId)}`;
  if (status) url += `&status=eq.${encodeURIComponent(status)}`;
  url += '&order=datum_zavrsetka_plan.asc.nullslast';
  const data = await sbReqThrow(url);
  if (!Array.isArray(data)) return [];
  return data.map(row => ({
    ...row,
    project_code: row.projects?.project_code ?? null,
    project_name: row.projects?.project_name ?? null,
    engineer_name: row.employees?.full_name ?? null,
    projects: undefined,
    employees: undefined,
  }));
}

function sanitizeTaskPayload(data) {
  const allowed = [
    'naziv', 'opis', 'problem', 'project_id', 'employee_id',
    'vrsta', 'prioritet', 'status',
    'datum_pocetka_plan', 'datum_zavrsetka_plan',
    'datum_pocetka_real', 'datum_zavrsetka_real',
    'procenat_zavrsenosti', 'norma_sati_dan',
  ];
  const out = {};
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(data, k)) {
      let v = data[k];
      if (v === '') v = null;
      out[k] = v;
    }
  }
  return out;
}

export async function createPbTask(data) {
  const payload = {
    ...sanitizeTaskPayload(data),
    created_by: actorEmail(),
    updated_by: actorEmail(),
  };
  assertValidTaskInput(payload, false);
  const res = await sbReqThrow('pb_tasks', 'POST', payload, { upsert: false });
  return Array.isArray(res) && res[0] ? res[0] : null;
}

export async function updatePbTask(id, data) {
  if (!id) return null;
  const payload = {
    ...sanitizeTaskPayload(data),
    updated_by: actorEmail(),
  };
  assertValidTaskInput(payload, true);
  const res = await sbReqThrow(
    `pb_tasks?id=eq.${encodeURIComponent(id)}`,
    'PATCH',
    payload,
  );
  return Array.isArray(res) && res[0] ? res[0] : null;
}

/**
 * Brza promena statusa (Kanban). Vraća `{ ok, row?, status? }` za razlikovanje 403 i mreže.
 */
export async function quickUpdatePbTaskStatus(id, newStatus) {
  if (!id || !newStatus || !getIsOnline()) return { ok: false, status: 0 };
  const email = actorEmail();
  const payload = { status: newStatus, updated_by: email };
  return patchPbTasksResponse(
    `pb_tasks?id=eq.${encodeURIComponent(id)}&deleted_at=is.null`,
    payload,
  );
}

/**
 * @returns {Promise<{ ok: boolean, row?: object, status: number }>}
 */
async function patchPbTasksResponse(path, payload) {
  if (!hasSupabaseConfig()) return { ok: false, status: 0 };

  const user = getCurrentUser();
  const token = user?._token || SUPABASE_CONFIG.anonKey;
  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_CONFIG.anonKey,
    'Authorization': `Bearer ${token}`,
    Prefer: 'return=representation',
  };

  try {
    const r = await fetch(SUPABASE_CONFIG.url + '/rest/v1/' + path, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(payload),
    });
    const txt = await r.text();
    if (!r.ok) {
      console.error('SB PATCH err', { path, status: r.status, body: txt });
      return { ok: false, status: r.status };
    }
    let parsed = null;
    if (txt) {
      try {
        parsed = JSON.parse(txt);
      } catch {
        parsed = null;
      }
    }
    const row = Array.isArray(parsed) && parsed[0] ? parsed[0] : null;
    return { ok: true, status: r.status, row };
  } catch (e) {
    console.error('SB PATCH fetch failed', e);
    return { ok: false, status: 0 };
  }
}

export async function softDeletePbTask(id) {
  if (!id) throw new Error('ID nedostaje');
  const payload = {
    deleted_at: new Date().toISOString(),
    updated_by: actorEmail(),
  };
  await sbReqThrow(
    `pb_tasks?id=eq.${encodeURIComponent(id)}&deleted_at=is.null`,
    'PATCH',
    payload,
  );
}

export async function getPbLoadStats(windowDays = 30) {
  if (!getIsOnline()) return [];
  const body = { window_days: windowDays };
  const data = await sbReqThrow('rpc/pb_get_load_stats', 'POST', body);
  return Array.isArray(data) ? data : [];
}

/**
 * @param {{
 *   employeeId?: string|null,
 *   dateFrom?: string|null,
 *   dateTo?: string|null,
 *   limit?: number,
 *   offset?: number,
 * }} filters
 */
export async function getPbWorkReports(filters = {}) {
  if (!getIsOnline()) return [];
  const limit = filters.limit != null ? Number(filters.limit) : 500;
  const offset = filters.offset != null ? Number(filters.offset) : 0;
  let url =
    'pb_work_reports?select=*,employees(full_name)'
    + '&order=datum.desc,created_at.desc';
  const { employeeId, dateFrom, dateTo } = filters;
  if (employeeId) url += `&employee_id=eq.${encodeURIComponent(employeeId)}`;
  if (dateFrom) url += `&datum=gte.${encodeURIComponent(dateFrom)}`;
  if (dateTo) url += `&datum=lte.${encodeURIComponent(dateTo)}`;
  url += `&limit=${encodeURIComponent(String(limit))}`;
  if (offset > 0) url += `&offset=${encodeURIComponent(String(offset))}`;
  const data = await sbReqThrow(url);
  if (!Array.isArray(data)) return [];
  return data.map(row => ({
    ...row,
    engineer_name: row.employees?.full_name ?? null,
    employees: undefined,
  }));
}

export async function createPbWorkReport(data) {
  if (!getIsOnline()) {
    const e = new Error('Offline');
    e.code = 'OFFLINE';
    throw e;
  }
  if (!data.datum) {
    const e = new Error('Datum je obavezan');
    e.code = 'VALIDATION';
    throw e;
  }
  const sat = Number(data.sati);
  if (!Number.isFinite(sat) || sat <= 0 || sat > 24) {
    const e = new Error('Sati moraju biti između 0.5 i 24');
    e.code = 'VALIDATION';
    throw e;
  }
  const email = actorEmail();
  const payload = {
    employee_id: data.employee_id || null,
    datum: data.datum || null,
    sati: sat,
    opis: data.opis ?? '',
    created_by: email,
  };
  const res = await sbReqThrow('pb_work_reports', 'POST', payload, { upsert: false });
  return Array.isArray(res) && res[0] ? res[0] : null;
}

export async function deletePbWorkReport(id) {
  if (!id || !getIsOnline()) {
    const e = new Error('Offline');
    e.code = 'OFFLINE';
    throw e;
  }
  await sbReqThrow(`pb_work_reports?id=eq.${encodeURIComponent(id)}`, 'DELETE');
}

export async function getPbNotifConfig() {
  if (!getIsOnline()) return null;
  const data = await sbReqThrow('pb_notification_config?id=eq.1');
  return Array.isArray(data) && data[0] ? data[0] : null;
}

export async function updatePbNotifConfig(patch) {
  if (!getIsOnline()) return null;
  const payload = {
    ...patch,
    updated_by: actorEmail(),
    updated_at: new Date().toISOString(),
  };
  const res = await sbReqThrow(
    'pb_notification_config?id=eq.1',
    'PATCH',
    payload,
  );
  return Array.isArray(res) && res[0] ? res[0] : null;
}
