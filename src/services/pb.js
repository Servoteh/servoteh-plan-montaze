/**
 * Projektni biro — Supabase servis (pb_tasks, pb_work_reports, load stats).
 */

import { sbReq } from './supabase.js';
import { SUPABASE_CONFIG, hasSupabaseConfig } from '../lib/constants.js';
import { getCurrentUser, getIsOnline } from '../state/auth.js';

/** @returns {string|null} */
function actorEmail() {
  const u = getCurrentUser();
  return u?.email ? String(u.email) : null;
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
  const data = await sbReq(url);
  return Array.isArray(data) ? data : [];
}

/**
 * Aktivni zaposleni za filter / dodelu.
 */
export async function getPbEngineers() {
  if (!getIsOnline()) return [];
  const url =
    'employees?select=id,full_name,department'
    + '&is_active=eq.true'
    + '&order=full_name.asc';
  const data = await sbReq(url);
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
  const data = await sbReq(url);
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
  const email = actorEmail();
  const payload = {
    ...sanitizeTaskPayload(data),
    created_by: email,
    updated_by: email,
  };
  const res = await sbReq('pb_tasks', 'POST', payload, { upsert: false });
  return Array.isArray(res) && res[0] ? res[0] : null;
}

export async function updatePbTask(id, data) {
  if (!id) return null;
  const payload = {
    ...sanitizeTaskPayload(data),
    updated_by: actorEmail(),
  };
  const res = await sbReq(
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
  if (!id) return false;
  const payload = {
    deleted_at: new Date().toISOString(),
    updated_by: actorEmail(),
  };
  const res = await sbReq(
    `pb_tasks?id=eq.${encodeURIComponent(id)}`,
    'PATCH',
    payload,
  );
  return res !== null;
}

export async function getPbLoadStats(windowDays = 30) {
  if (!getIsOnline()) return [];
  const body = { window_days: windowDays };
  const data = await sbReq('rpc/pb_get_load_stats', 'POST', body);
  return Array.isArray(data) ? data : [];
}
