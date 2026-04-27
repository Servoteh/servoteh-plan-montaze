/**
 * Servisi za modul održavanje mašina (Supabase REST).
 * Zavisi od migracije sql/migrations/add_maintenance_module.sql.
 */

import { sbReq, getSupabaseUrl, getSupabaseAnonKey } from './supabase.js';
import { getCurrentUser } from '../state/auth.js';
import { parseSupabaseStorageSignResponse, absolutizeSupabaseStorageSignedPath } from './drawings.js';

const MAINT_FILES_BUCKET = 'maint-machine-files';

/** @param {string} code */
function enc(code) {
  return encodeURIComponent(code);
}

/**
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<Array<{ machine_code: string, status: string, open_incidents_count: number, overdue_checks_count: number }>|null>}
 */
export async function fetchMaintMachineStatuses(opts = {}) {
  const limit = opts.limit ?? 500;
  return await sbReq(
    `v_maint_machine_current_status?select=machine_code,status,open_incidents_count,overdue_checks_count,override_reason,override_valid_until&order=machine_code.asc&limit=${limit}`
  );
}

/**
 * Poslednja urađena kontrola po mašini — Map<machine_code, ISO datum>.
 * Čita iz `maint_checks` i agregira klijentski (do nekoliko hiljada redova
 * prolazi kroz jedan fetch; ako preraste, treba SQL view sa GROUP BY).
 *
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<Map<string, string>>}
 */
export async function fetchMaintMachineLastChecks(opts = {}) {
  const lim = opts.limit ?? 5000;
  const rows = await sbReq(
    `maint_checks?select=machine_code,performed_at&order=performed_at.desc&limit=${lim}`,
  );
  const m = new Map();
  if (Array.isArray(rows)) {
    for (const r of rows) {
      const k = r?.machine_code;
      const t = r?.performed_at;
      if (!k || !t) continue;
      /* Rows su već sortirane desc — prvi hit je najskoriji. */
      if (!m.has(k)) m.set(k, t);
    }
  }
  return m;
}

/**
 * Poslednji incident po mašini (bilo koji status) — za „Istorija" merged
 * timeline ne treba, ali za listu može biti korisno kao „last event".
 * Trenutno se ne koristi — ostavljeno za sledeći krug.
 *
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<Map<string, { reported_at: string, title: string, status: string }>>}
 */
export async function fetchMaintMachineLastIncidents(opts = {}) {
  const lim = opts.limit ?? 5000;
  const rows = await sbReq(
    `maint_incidents?select=machine_code,reported_at,title,status&order=reported_at.desc&limit=${lim}`,
  );
  const m = new Map();
  if (Array.isArray(rows)) {
    for (const r of rows) {
      const k = r?.machine_code;
      if (!k) continue;
      if (!m.has(k)) m.set(k, {
        reported_at: r.reported_at,
        title: r.title || '',
        status: r.status || '',
      });
    }
  }
  return m;
}

/**
 * Nazivi mašina iz BigTehn cache-a (read-only).
 * Po defaultu skriva „ne-mašine” (`no_procedure=true`: Kontrola, Kooperacija,
 * Montaža, Transport…). Postavi `includeNonMachining:true` kad ti treba
 * kompletan lookup (npr. za prikaz imena starih incidenata/notifikacija).
 * @param {{ limit?: number, includeNonMachining?: boolean }} [opts]
 * @returns {Promise<Array<{ rj_code: string, name: string, no_procedure?: boolean }>|null>}
 */
export async function fetchBigtehnMachineNames(opts = {}) {
  const limit = opts.limit ?? 2000;
  const parts = [
    'select=rj_code,name,no_procedure',
    `order=name.asc&limit=${limit}`,
  ];
  if (!opts.includeNonMachining) {
    /* `NOT IS TRUE` pokriva i NULL i false — tj. sve što NIJE eksplicitno true. */
    parts.push('no_procedure=not.is.true');
  }
  return await sbReq(`bigtehn_machines_cache?${parts.join('&')}`);
}

/**
 * @returns {Promise<object|null>}
 */
export async function fetchMaintUserProfile() {
  const uid = getCurrentUser()?.id;
  if (!uid) return null;
  const rows = await sbReq(`maint_user_profiles?select=*&user_id=eq.${uid}&limit=1`);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/**
 * @param {string} machineCode
 * @returns {Promise<Array<object>|null>}
 */
export async function fetchMaintTasksForMachine(machineCode) {
  return await sbReq(
    `maint_tasks?select=id,title,severity,interval_value,interval_unit,active,grace_period_days&machine_code=eq.${enc(machineCode)}&active=eq.true&order=title.asc`
  );
}

/**
 * Svi šabloni kontrola (aktivni i neaktivni) za jednu mašinu — za admin/šef CRUD.
 * @param {string} machineCode
 * @returns {Promise<Array<object>|null>}
 */
export async function fetchMaintTasksForMachineAll(machineCode) {
  return await sbReq(
    `maint_tasks?select=*&machine_code=eq.${enc(machineCode)}&order=active.desc,title.asc`
  );
}

/**
 * @param {{ machine_code: string, title: string, description?: string|null,
 *           instructions?: string|null, interval_value: number,
 *           interval_unit: 'hours'|'days'|'weeks'|'months',
 *           severity?: 'normal'|'important'|'critical',
 *           required_role?: 'operator'|'technician'|'chief'|'management'|'admin',
 *           grace_period_days?: number, active?: boolean }} payload
 * @returns {Promise<object|null>}
 */
export async function insertMaintTask(payload) {
  const uid = getCurrentUser()?.id;
  const body = {
    machine_code: payload.machine_code,
    title: payload.title,
    description: payload.description || null,
    instructions: payload.instructions || null,
    interval_value: payload.interval_value,
    interval_unit: payload.interval_unit,
    severity: payload.severity || 'normal',
    required_role: payload.required_role || 'operator',
    grace_period_days: payload.grace_period_days ?? 3,
    active: payload.active ?? true,
    created_by: uid || null,
    updated_by: uid || null,
  };
  const rows = await sbReq('maint_tasks', 'POST', body);
  return Array.isArray(rows) && rows[0] ? rows[0] : rows;
}

/**
 * @param {string} taskId uuid
 * @param {object} fields
 * @returns {Promise<boolean>}
 */
export async function patchMaintTask(taskId, fields) {
  const uid = getCurrentUser()?.id;
  const r = await sbReq(
    `maint_tasks?id=eq.${encodeURIComponent(taskId)}`,
    'PATCH',
    { ...fields, updated_by: uid || null },
  );
  return r !== null;
}

/**
 * Brisanje šablona uklanja i celu istoriju (`maint_checks` FK ON DELETE CASCADE).
 * Preporučeno: koristi `patchMaintTask(id, { active: false })` umesto ovoga.
 * @param {string} taskId uuid
 * @returns {Promise<boolean>}
 */
export async function deleteMaintTask(taskId) {
  const r = await sbReq(
    `maint_tasks?id=eq.${encodeURIComponent(taskId)}`,
    'DELETE',
  );
  return r !== null;
}

/**
 * Istorija urađenih kontrola (maint_checks) za jednu mašinu — koristi se u
 * „Istorija" tabu za merged timeline (incidenti + kontrole).
 *
 * @param {string} machineCode
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<Array<object>|null>}
 */
export async function fetchMaintChecksForMachine(machineCode, opts = {}) {
  const lim = opts.limit ?? 100;
  return await sbReq(
    `maint_checks?select=id,task_id,machine_code,performed_at,performed_by,result,notes&machine_code=eq.${enc(machineCode)}&order=performed_at.desc&limit=${lim}`,
  );
}

/**
 * @param {string} machineCode
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<Array<object>|null>}
 */
export async function fetchMaintIncidentsForMachine(machineCode, opts = {}) {
  const lim = opts.limit ?? 30;
  return await sbReq(
    `maint_incidents?select=id,title,severity,status,reported_at,assigned_to,work_order_id,maint_work_orders(wo_id,wo_number,status,title,priority)&machine_code=eq.${enc(machineCode)}&order=reported_at.desc&limit=${lim}`,
  );
}

/**
 * @param {string} machineCode
 * @returns {Promise<object|null>}
 */
export async function fetchBigtehnMachineRow(machineCode) {
  const rows = await sbReq(
    `bigtehn_machines_cache?select=rj_code,name,no_procedure,department_id&rj_code=eq.${enc(machineCode)}&limit=1`
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/**
 * @returns {Promise<Array<object>|null>}
 */
export async function fetchAllMaintProfiles() {
  return await sbReq('maint_user_profiles?select=*&order=full_name.asc&limit=500');
}

/**
 * @param {object} row
 * @returns {Promise<object|null>}
 */
export async function insertMaintProfile(row) {
  return await sbReq('maint_user_profiles', 'POST', row);
}

/**
 * @param {string} userId uuid
 * @param {object} fields
 * @returns {Promise<object|null>}
 */
export async function patchMaintProfile(userId, fields) {
  const r = await sbReq(`maint_user_profiles?user_id=eq.${encodeURIComponent(userId)}`, 'PATCH', fields);
  return r !== null;
}

/**
 * @param {{ task_id: string, machine_code: string, result: string, notes?: string|null }} payload
 * @returns {Promise<object|null>}
 */
export async function insertMaintCheck(payload) {
  const uid = getCurrentUser()?.id;
  if (!uid) return null;
  const body = {
    task_id: payload.task_id,
    machine_code: payload.machine_code,
    performed_by: uid,
    result: payload.result,
    notes: payload.notes || null,
    attachment_urls: [],
  };
  const rows = await sbReq('maint_checks', 'POST', body);
  return Array.isArray(rows) && rows[0] ? rows[0] : rows;
}

/**
 * @param {{ machine_code: string, title: string, description?: string|null, severity: string }} payload
 * @returns {Promise<object|null>}
 */
export async function insertMaintIncident(payload) {
  const uid = getCurrentUser()?.id;
  if (!uid) return null;
  const body = {
    machine_code: payload.machine_code,
    asset_id: payload.asset_id || null,
    asset_type: payload.asset_type || null,
    reported_by: uid,
    title: payload.title,
    description: payload.description || null,
    severity: payload.severity,
    safety_marker: !!payload.safety_marker,
    status: 'open',
    attachment_urls: [],
  };
  const rows = await sbReq('maint_incidents', 'POST', body);
  return Array.isArray(rows) && rows[0] ? rows[0] : rows;
}

/**
 * @param {{ incident_id: string, event_type: string, comment?: string|null, from_value?: string|null, to_value?: string|null }} payload
 * @returns {Promise<object|null>}
 */
export async function insertMaintIncidentEvent(payload) {
  const uid = getCurrentUser()?.id;
  const body = {
    incident_id: payload.incident_id,
    actor: uid,
    event_type: payload.event_type,
    comment: payload.comment || null,
    from_value: payload.from_value ?? null,
    to_value: payload.to_value ?? null,
  };
  const rows = await sbReq('maint_incident_events', 'POST', body);
  return Array.isArray(rows) && rows[0] ? rows[0] : rows;
}

/**
 * @param {string} incidentId uuid
 * @returns {Promise<object|null>}
 */
export async function fetchIncidentById(incidentId) {
  const rows = await sbReq(
    `maint_incidents?select=*,maint_work_orders(wo_id,wo_number,status,title,priority)&id=eq.${encodeURIComponent(incidentId)}&limit=1`,
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/**
 * @param {string} incidentId uuid
 * @returns {Promise<Array<object>|null>}
 */
export async function fetchIncidentEvents(incidentId) {
  return await sbReq(
    `maint_incident_events?select=*&incident_id=eq.${encodeURIComponent(incidentId)}&order=at.asc`,
  );
}

/**
 * @param {string} incidentId uuid
 * @param {object} fields npr. status, assigned_to, updated_by, resolved_at, closed_at, resolution_notes
 * @returns {Promise<boolean>}
 */
export async function patchMaintIncident(incidentId, fields) {
  const r = await sbReq(`maint_incidents?id=eq.${encodeURIComponent(incidentId)}`, 'PATCH', fields);
  return r !== null;
}

/**
 * Lista za padajuće dodeljivanje (RPC `maint_assignable_users`; vidi add_maint_assignable_users_rpc.sql).
 * @returns {Promise<Array<{ user_id: string, full_name: string, maint_role: string }>|null>}
 */
export async function fetchAssignableMaintUsers() {
  const rows = await sbReq('rpc/maint_assignable_users', 'POST', {});
  return Array.isArray(rows) ? rows : null;
}

/**
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<Array<object>|null>}
 */
export async function fetchMaintTaskDueDates(opts = {}) {
  const lim = opts.limit ?? 2000;
  return await sbReq(
    `v_maint_task_due_dates?select=task_id,machine_code,title,severity,interval_value,interval_unit,next_due_at,last_performed_at&order=next_due_at.asc&limit=${lim}`,
  );
}

/**
 * @param {string} machineCode
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<Array<object>|null>}
 */
export async function fetchMaintMachineNotes(machineCode, opts = {}) {
  const lim = opts.limit ?? 100;
  return await sbReq(
    `maint_machine_notes?select=*&machine_code=eq.${enc(machineCode)}&deleted_at=is.null&order=pinned.desc,created_at.desc&limit=${lim}`,
  );
}

/**
 * @param {{ machine_code: string, content: string }} payload
 * @returns {Promise<object|null>}
 */
export async function insertMaintMachineNote(payload) {
  const uid = getCurrentUser()?.id;
  if (!uid) return null;
  const body = {
    machine_code: payload.machine_code,
    author: uid,
    content: payload.content,
  };
  const rows = await sbReq('maint_machine_notes', 'POST', body);
  return Array.isArray(rows) && rows[0] ? rows[0] : rows;
}

/**
 * @param {string} noteId uuid
 * @param {object} fields npr. content, pinned, deleted_at
 * @returns {Promise<boolean>}
 */
export async function patchMaintMachineNote(noteId, fields) {
  const r = await sbReq(`maint_machine_notes?id=eq.${encodeURIComponent(noteId)}`, 'PATCH', fields);
  return r !== null;
}

/**
 * Trenutni manuelni override (ako postoji i nije istekao).
 * @param {string} machineCode
 * @returns {Promise<object|null>}
 */
export async function fetchMaintMachineOverride(machineCode) {
  const rows = await sbReq(
    `maint_machine_status_override?select=*&machine_code=eq.${enc(machineCode)}&limit=1`,
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/**
 * Upsert override-a. `valid_until` null znači trajno dok ručno ne skine.
 * Oslanja se na `Prefer: resolution=merge-duplicates` u `sbReq` za POST.
 * @param {{ machine_code: string, status: 'running'|'degraded'|'down'|'maintenance',
 *           reason: string, valid_until?: string|null }} payload
 * @returns {Promise<boolean>}
 */
export async function upsertMaintMachineOverride(payload) {
  const uid = getCurrentUser()?.id;
  if (!uid) return false;
  const body = {
    machine_code: payload.machine_code,
    status: payload.status,
    reason: payload.reason,
    set_by: uid,
    set_at: new Date().toISOString(),
    valid_until: payload.valid_until || null,
  };
  const r = await sbReq('maint_machine_status_override', 'POST', body);
  return r !== null;
}

/**
 * @param {string} machineCode
 * @returns {Promise<boolean>}
 */
export async function deleteMaintMachineOverride(machineCode) {
  const r = await sbReq(
    `maint_machine_status_override?machine_code=eq.${enc(machineCode)}`,
    'DELETE',
  );
  return r !== null;
}

/**
 * Vidljiva CMMS sredstva za izbor u incidentu / WO.
 * @param {{ q?: string, limit?: number }} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function fetchMaintAssetsForPicker(opts = {}) {
  const limit = Math.min(opts.limit ?? 300, 1000);
  const q = String(opts.q || '').trim();
  const parts = [
    'select=asset_id,asset_code,asset_type,name,status,active,archived_at',
    'active=eq.true',
    'archived_at=is.null',
    'order=asset_code.asc',
    `limit=${limit}`,
  ];
  if (q) {
    const like = enc(`*${q.replace(/[,*]/g, ' ')}*`);
    parts.push(`or=(asset_code.ilike.${like},name.ilike.${like})`);
  }
  const rows = await sbReq(`maint_assets?${parts.join('&')}`).catch(() => null);
  return Array.isArray(rows) ? rows : [];
}

/* ── Katalog mašina (maint_machines) ─────────────────────────────────────── */

/* `responsible_user_id` NIJE u ovoj listi namerno — dodat je u posebnoj
   migraciji (add_maint_machine_responsible.sql) i mogu postojati instalacije
   gde još nije pokrenut. Čitamo ga best-effort preko fetchMaintMachineResponsibles(). */
const MAINT_MACHINE_COLS =
  'machine_code,name,type,manufacturer,model,serial_number,year_of_manufacture,year_commissioned,location,department_id,power_kw,weight_kg,notes,tracked,archived_at,source,created_at,updated_at,updated_by';

/**
 * Lista mašina iz `maint_machines` (katalog Održavanja).
 * @param {{ includeArchived?: boolean, limit?: number }} [opts]
 * @returns {Promise<Array<object>|null>}
 */
export async function fetchMaintMachines(opts = {}) {
  const limit = opts.limit ?? 2000;
  const parts = [
    `select=${MAINT_MACHINE_COLS}`,
    `order=name.asc&limit=${limit}`,
  ];
  if (!opts.includeArchived) {
    parts.push('archived_at=is.null');
  }
  return await sbReq(`maint_machines?${parts.join('&')}`);
}

/**
 * @param {string} machineCode
 * @returns {Promise<object|null>}
 */
export async function fetchMaintMachine(machineCode) {
  const rows = await sbReq(
    `maint_machines?select=${MAINT_MACHINE_COLS}&machine_code=eq.${enc(machineCode)}&limit=1`,
  );
  const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
  if (row) {
    /* Best-effort: responsible_user_id + asset_id (add_maint_* migracije; bez kolone
       PostgREST 400 — probamo uže polje). */
    let extra = await sbReq(
      `maint_machines?select=responsible_user_id,asset_id&machine_code=eq.${enc(machineCode)}&limit=1`,
    ).catch(() => null);
    if (!Array.isArray(extra) || !extra[0]) {
      extra = await sbReq(
        `maint_machines?select=responsible_user_id&machine_code=eq.${enc(machineCode)}&limit=1`,
      ).catch(() => null);
    }
    if (Array.isArray(extra) && extra[0]) {
      if ('responsible_user_id' in extra[0]) {
        row.responsible_user_id = extra[0].responsible_user_id || null;
      }
      if ('asset_id' in extra[0]) {
        row.asset_id = extra[0].asset_id || null;
      }
    }
  }
  return row;
}

/**
 * Proveri da li je migracija add_maint_machine_responsible.sql pokrenuta —
 * tj. da li kolona `maint_machines.responsible_user_id` postoji u bazi.
 * Rezultat je keširan za session (da izbegnemo ponovne HEAD request-e).
 *
 * @returns {Promise<boolean>}
 */
let _respFeatureCache = null;
export async function isMaintResponsibleFeatureAvailable() {
  if (_respFeatureCache !== null) return _respFeatureCache;
  const probe = await sbReq('maint_machines?select=responsible_user_id&limit=1').catch(() => null);
  _respFeatureCache = Array.isArray(probe);
  return _respFeatureCache;
}

/**
 * Vraća responsible_user_id za jednu mašinu (best-effort, null ako kolona ne
 * postoji ili mašina nema dodeljenog odgovornog).
 *
 * @param {string} machineCode
 * @returns {Promise<string|null>}
 */
export async function fetchMaintMachineResponsibleFor(machineCode) {
  if (!machineCode) return null;
  const rows = await sbReq(
    `maint_machines?select=responsible_user_id&machine_code=eq.${enc(machineCode)}&limit=1`,
  ).catch(() => null);
  if (!Array.isArray(rows) || !rows[0]) return null;
  return rows[0].responsible_user_id || null;
}

/**
 * Vraća Map<machine_code, responsible_user_id> — best-effort. Ako migracija
 * add_maint_machine_responsible.sql nije pokrenuta, kolona ne postoji, fetch
 * vrati null i mi vratimo prazan Map (UI skriva „Moje" filter).
 *
 * @returns {Promise<Map<string, string>>}
 */
export async function fetchMaintMachineResponsibles() {
  const rows = await sbReq(
    'maint_machines?select=machine_code,responsible_user_id&archived_at=is.null&limit=5000',
  ).catch(() => null);
  const m = new Map();
  if (Array.isArray(rows)) {
    for (const r of rows) {
      if (r?.machine_code && r?.responsible_user_id) {
        m.set(r.machine_code, r.responsible_user_id);
      }
    }
  }
  return m;
}

/**
 * Ručno kreiranje mašine (source='manual'). `machine_code` je PK — ako postoji,
 * insert će pasti na RLS-u ili duplicate key. Koristimo Prefer=return=representation.
 * @param {{ machine_code: string, name: string, [k: string]: any }} payload
 * @returns {Promise<object|null>}
 */
export async function insertMaintMachine(payload) {
  const uid = getCurrentUser()?.id;
  const body = {
    machine_code: String(payload.machine_code).trim(),
    name: String(payload.name).trim(),
    type: payload.type ?? null,
    manufacturer: payload.manufacturer ?? null,
    model: payload.model ?? null,
    serial_number: payload.serial_number ?? null,
    year_of_manufacture: payload.year_of_manufacture ?? null,
    year_commissioned: payload.year_commissioned ?? null,
    location: payload.location ?? null,
    department_id: payload.department_id ?? null,
    power_kw: payload.power_kw ?? null,
    weight_kg: payload.weight_kg ?? null,
    notes: payload.notes ?? null,
    tracked: payload.tracked !== false,
    source: payload.source || 'manual',
    updated_by: uid || null,
  };
  /* responsible_user_id šaljemo samo ako je eksplicitno zadat (migracija je
     opciona — bez nje PostgREST vraća 400 ako kolona ne postoji). */
  if (payload.responsible_user_id !== undefined) {
    body.responsible_user_id = payload.responsible_user_id || null;
  }
  /* `asset_id` ne šaljemo — NOT NULL u bazi popunjava trigger pre INSERT-a. */
  /* upsert:false → čist INSERT (ako postoji machine_code, vraća grešku — ne
     prepisujemo potencijalno arhivirani red). */
  const rows = await sbReq('maint_machines', 'POST', body, { upsert: false });
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/**
 * Patch pojedinačnih polja. `machine_code` se NIKAD ne menja (PK).
 * @param {string} machineCode
 * @param {Record<string, any>} patch
 * @returns {Promise<boolean>}
 */
export async function patchMaintMachine(machineCode, patch) {
  const body = { ...patch };
  delete body.machine_code;
  delete body.created_at;
  body.updated_by = getCurrentUser()?.id || null;
  const r = await sbReq(
    `maint_machines?machine_code=eq.${enc(machineCode)}`,
    'PATCH',
    body,
  );
  return r !== null;
}

/** Soft-delete: postavi archived_at = now(). */
export async function archiveMaintMachine(machineCode) {
  return await patchMaintMachine(machineCode, {
    archived_at: new Date().toISOString(),
    tracked: false,
  });
}

/** Vrati iz arhive. */
export async function restoreMaintMachine(machineCode) {
  return await patchMaintMachine(machineCode, {
    archived_at: null,
    tracked: true,
  });
}

/**
 * Kandidati za uvoz iz BigTehn-a (oni koji nisu još u maint_machines).
 * @param {{ onlyMachining?: boolean, limit?: number }} [opts]
 * @returns {Promise<Array<{ machine_code: string, name: string, department_id?: string, no_procedure: boolean }>|null>}
 */
export async function fetchMaintMachinesImportable(opts = {}) {
  const limit = opts.limit ?? 2000;
  const parts = [
    'select=machine_code,name,department_id,no_procedure',
    `order=machine_code.asc&limit=${limit}`,
  ];
  if (opts.onlyMachining !== false) {
    parts.push('no_procedure=is.false');
  }
  return await sbReq(`v_maint_machines_importable?${parts.join('&')}`);
}

/**
 * Trajno brisanje mašine + audit zapis. Pošto se kaskadno briše i meta-data
 * dokumenata, ovde PRVO ručno brišemo binarne fajlove iz Storage bucket-a
 * (RPC ne može da priča sa Storage HTTP API-jem) — zatim atomski RPC briše
 * sve red-ove iz baze i upisuje audit zapis.
 *
 * Ovlašćenja (proverava i RPC, ovde samo gradimo poziv):
 *   • ERP admin
 *   • ERP menadzment
 *   • maint chief / admin
 *
 * @param {string} machineCode
 * @param {string} reason min. 5 karaktera (RPC pada inače sa 22023)
 * @returns {Promise<{ ok: boolean, result?: object, error?: string,
 *                     storageFailures?: number }>}
 */
export async function deleteMaintMachineHard(machineCode, reason) {
  const code = String(machineCode || '').trim();
  const why = String(reason || '').trim();
  if (!code) return { ok: false, error: 'Šifra mašine je obavezna.' };
  if (why.length < 5) return { ok: false, error: 'Razlog je obavezan (min 5 karaktera).' };

  /* 1) Pokušaj da pokupimo fajlove (sa obrisanim) i obrišemo ih iz Storage-a.
     Best-effort: ako ne uspe, idemo dalje — RPC svejedno čisti DB. */
  let storageFailures = 0;
  const files = await fetchMaintMachineFiles(code, { includeDeleted: true });
  if (Array.isArray(files) && files.length) {
    const user = getCurrentUser();
    const token = user?._token || getSupabaseAnonKey();
    const apiKey = getSupabaseAnonKey();
    const baseUrl = getSupabaseUrl();
    for (const f of files) {
      if (!f?.storage_path) continue;
      try {
        const r = await fetch(
          `${baseUrl}/storage/v1/object/${MAINT_FILES_BUCKET}/${encodeURI(f.storage_path)}`,
          {
            method: 'DELETE',
            headers: { 'Authorization': 'Bearer ' + token, 'apikey': apiKey },
          },
        );
        if (!r.ok && r.status !== 404) storageFailures++;
      } catch {
        storageFailures++;
      }
    }
  }

  /* 2) Atomski RPC: snapshot + cascade DB delete + audit. */
  const r = await sbReq('rpc/maint_machine_delete_hard', 'POST', {
    p_code: code,
    p_reason: why,
  });
  if (r && typeof r === 'object' && !Array.isArray(r) && r.ok === true) {
    return { ok: true, result: r, storageFailures };
  }
  if (Array.isArray(r) && r[0]?.ok === true) {
    return { ok: true, result: r[0], storageFailures };
  }
  return {
    ok: false,
    error: 'Brisanje nije uspelo (ovlašćenja, mašina ne postoji ili RPC greška).',
    storageFailures,
  };
}

/**
 * Audit log trajno obrisanih mašina (RLS: chief/admin/management/ERP admin).
 * @param {{ limit?: number, machineCode?: string }} [opts]
 * @returns {Promise<Array<object>|null>}
 */
export async function fetchMaintMachineDeletionLog(opts = {}) {
  const limit = opts.limit ?? 200;
  const parts = [
    'select=id,machine_code,machine_name,snapshot,related_counts,reason,deleted_at,deleted_by_email',
    `order=deleted_at.desc&limit=${limit}`,
  ];
  if (opts.machineCode) {
    parts.push(`machine_code=eq.${enc(opts.machineCode)}`);
  }
  return await sbReq(`maint_machines_deletion_log?${parts.join('&')}`);
}

/**
 * Brojači aktivnih dokumenata po mašini — koristi se za badge u katalogu.
 * Vraća Map<machine_code, number>. Klijentska agregacija (do par hiljada redova
 * je ok); ako naraste, dodati view sa GROUP BY u SQL-u.
 * @returns {Promise<Map<string, number>>}
 */
export async function fetchMaintMachineFilesCounts() {
  const rows = await sbReq(
    'maint_machine_files?select=machine_code&deleted_at=is.null&limit=10000',
  );
  const m = new Map();
  if (Array.isArray(rows)) {
    for (const r of rows) {
      const k = r?.machine_code;
      if (!k) continue;
      m.set(k, (m.get(k) || 0) + 1);
    }
  }
  return m;
}

/**
 * Atomski preimenuje šifru mašine u svim `maint_*` tabelama.
 * Zove RPC `maint_machine_rename(old, new)`. Chief/admin only.
 * @param {string} oldCode
 * @param {string} newCode
 * @returns {Promise<{ ok: boolean, result?: object, error?: string }>}
 */
export async function renameMaintMachine(oldCode, newCode) {
  const r = await sbReq('rpc/maint_machine_rename', 'POST', {
    p_old_code: String(oldCode).trim(),
    p_new_code: String(newCode).trim(),
  });
  if (r && typeof r === 'object' && !Array.isArray(r)) {
    return { ok: true, result: r };
  }
  if (Array.isArray(r) && r[0] && typeof r[0] === 'object') {
    return { ok: true, result: r[0] };
  }
  return { ok: false, error: 'RPC nije uspeo (ovlašćenja, kolizija šifre ili mašina ne postoji).' };
}

/**
 * Masovni uvoz iz BigTehn cache-a.
 * @param {string[]} codes rj_code lista
 * @returns {Promise<number>} broj stvarno uvezenih redova
 */
export async function importMaintMachinesFromCache(codes) {
  const arr = Array.isArray(codes) ? codes.filter(Boolean) : [];
  if (!arr.length) return 0;
  const r = await sbReq('rpc/maint_machines_import_from_cache', 'POST', {
    p_codes: arr,
  });
  if (typeof r === 'number') return r;
  if (Array.isArray(r) && typeof r[0] === 'number') return r[0];
  return 0;
}

/* ── Obaveštenja (maint_notification_log) ────────────────────────────────── */

/**
 * Listaj notifikacije iz outbox-a (RLS: chief/management/admin ili ERP admin).
 * @param {{ status?: 'queued'|'sent'|'failed'|'all',
 *           machineCode?: string,
 *           incidentId?: string,
 *           limit?: number }} [opts]
 * @returns {Promise<Array<object>|null>}
 */
export async function fetchMaintNotifications(opts = {}) {
  const limit = opts.limit ?? 200;
  const parts = [
    'select=id,channel,recipient,recipient_user_id,subject,body,status,attempts,error,scheduled_at,next_attempt_at,last_attempt_at,sent_at,created_at,machine_code,related_entity_type,related_entity_id,escalation_level,payload',
    `order=created_at.desc&limit=${limit}`,
  ];
  if (opts.status && opts.status !== 'all') {
    parts.push(`status=eq.${enc(opts.status)}`);
  }
  if (opts.machineCode) {
    parts.push(`machine_code=eq.${enc(opts.machineCode)}`);
  }
  if (opts.incidentId) {
    parts.push(`related_entity_id=eq.${enc(opts.incidentId)}`);
  }
  return await sbReq(`maint_notification_log?${parts.join('&')}`);
}

/**
 * Vrati jednu notifikaciju iz 'failed' u 'queued' (RPC, SECURITY DEFINER).
 * @param {string} id uuid
 * @returns {Promise<boolean>}
 */
export async function retryMaintNotification(id) {
  const r = await sbReq('rpc/maint_notification_retry', 'POST', { p_id: id });
  /* RPC vraća boolean (true/false) ili null na grešku. */
  return r === true || (Array.isArray(r) && r[0] === true);
}

/* ── Dokumenti uz mašinu (maint_machine_files + Storage) ─────────────────── */

const MAINT_FILE_COLS = [
  'id', 'machine_code', 'file_name', 'storage_path',
  'mime_type', 'size_bytes', 'category', 'description',
  'uploaded_at', 'uploaded_by', 'deleted_at',
].join(',');

/**
 * Listaj dokumente za datu mašinu.
 * @param {string} machineCode
 * @param {{ includeDeleted?: boolean }} [opts]
 */
export async function fetchMaintMachineFiles(machineCode, opts = {}) {
  if (!machineCode) return [];
  const parts = [
    `select=${MAINT_FILE_COLS}`,
    `machine_code=eq.${enc(machineCode)}`,
    'order=uploaded_at.desc&limit=500',
  ];
  if (!opts.includeDeleted) parts.push('deleted_at=is.null');
  const rows = await sbReq(`maint_machine_files?${parts.join('&')}`);
  return Array.isArray(rows) ? rows : [];
}

/**
 * Uploaduje file u Storage bucket i upiše metadata u tabelu.
 * Ime fajla se sanitizuje, dodaje se uuid prefiks da se izbegnu kolizije.
 * @param {{ machineCode: string, file: File|Blob, category?: string, description?: string }} opts
 * @returns {Promise<{ ok: boolean, row?: object, error?: string }>}
 */
export async function uploadMaintMachineFile(opts) {
  const { machineCode, file, category, description } = opts || {};
  if (!machineCode || !file) return { ok: false, error: 'Nedostaju podaci.' };

  const origName = file.name || 'file';
  const safeName = String(origName)
    .normalize('NFKD')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'file';

  const uuid = (crypto?.randomUUID?.() || String(Date.now())).replace(/-/g, '').slice(0, 12);
  const storagePath = `${machineCode}/${uuid}_${safeName}`;

  const user = getCurrentUser();
  const token = user?._token || getSupabaseAnonKey();
  const apiKey = getSupabaseAnonKey();
  const baseUrl = getSupabaseUrl();

  /* 1) PUT u Storage */
  try {
    const r = await fetch(
      `${baseUrl}/storage/v1/object/${MAINT_FILES_BUCKET}/${encodeURI(storagePath)}`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'apikey': apiKey,
          'Content-Type': file.type || 'application/octet-stream',
          'x-upsert': 'false',
          'cache-control': '3600',
        },
        body: file,
      },
    );
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.error('[uploadMaintMachineFile] storage failed', r.status, txt);
      return { ok: false, error: `Storage upload (${r.status}): ${txt || 'fail'}` };
    }
  } catch (e) {
    console.error('[uploadMaintMachineFile] storage exception', e);
    return { ok: false, error: 'Mreža/Storage greška.' };
  }

  /* 2) INSERT metadata */
  const payload = {
    machine_code: machineCode,
    file_name:    origName,
    storage_path: storagePath,
    mime_type:    file.type || null,
    size_bytes:   file.size || null,
    category:     category ? String(category).slice(0, 40) : null,
    description:  description ? String(description).slice(0, 500) : null,
    uploaded_by:  user?.id || null,
  };
  const res = await sbReq('maint_machine_files', 'POST', payload, { upsert: false });
  const row = Array.isArray(res) ? (res[0] || null) : (res || null);
  if (!row) {
    /* Best-effort cleanup: obriši uploadovani blob da ne ostane „siroče". */
    try {
      await fetch(
        `${baseUrl}/storage/v1/object/${MAINT_FILES_BUCKET}/${encodeURI(storagePath)}`,
        { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token, 'apikey': apiKey } },
      );
    } catch { /* ignore */ }
    return { ok: false, error: 'Metadata upis u bazu nije uspeo (RLS?).' };
  }
  return { ok: true, row };
}

/**
 * Vraća signed URL (preview/download) za dati storage_path.
 * @param {string} storagePath
 * @param {number} [expiresSec] trajanje linka, default 5 min
 * @returns {Promise<string|null>}
 */
export async function getMaintMachineFileSignedUrl(storagePath, expiresSec = 300) {
  if (!storagePath) return null;
  const user = getCurrentUser();
  const token = user?._token || getSupabaseAnonKey();
  const apiKey = getSupabaseAnonKey();
  const baseUrl = getSupabaseUrl();
  const headers = {
    'Authorization': 'Bearer ' + token,
    'apikey': apiKey,
    'Content-Type': 'application/json',
  };
  try {
    const rBatch = await fetch(
      `${baseUrl}/storage/v1/object/sign/${MAINT_FILES_BUCKET}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ expiresIn: expiresSec, paths: [storagePath] }),
      },
    );
    if (rBatch.ok) {
      const j = await rBatch.json().catch(() => null);
      const rel = parseSupabaseStorageSignResponse(j);
      const full = absolutizeSupabaseStorageSignedPath(baseUrl, rel);
      if (full) return full;
    }
    const r = await fetch(
      `${baseUrl}/storage/v1/object/sign/${MAINT_FILES_BUCKET}/${encodeURIComponent(storagePath)}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ expiresIn: expiresSec }),
      },
    );
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    const rel = parseSupabaseStorageSignResponse(j);
    return absolutizeSupabaseStorageSignedPath(baseUrl, rel);
  } catch (e) {
    console.error('[getMaintMachineFileSignedUrl]', e);
    return null;
  }
}

/**
 * Obriši dokument: soft-delete reda u tabeli + pokušaj delete u Storage.
 * @param {{ id: string, storage_path: string }} file
 */
export async function deleteMaintMachineFile(file) {
  if (!file?.id) return false;
  const params = new URLSearchParams();
  params.set('id', `eq.${file.id}`);
  const ok = await sbReq(
    `maint_machine_files?${params.toString()}`,
    'PATCH',
    { deleted_at: new Date().toISOString() },
  );
  if (ok === null) return false;

  if (file.storage_path) {
    const user = getCurrentUser();
    const token = user?._token || getSupabaseAnonKey();
    const apiKey = getSupabaseAnonKey();
    const baseUrl = getSupabaseUrl();
    try {
      await fetch(
        `${baseUrl}/storage/v1/object/${MAINT_FILES_BUCKET}/${encodeURI(file.storage_path)}`,
        { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token, 'apikey': apiKey } },
      );
    } catch { /* best-effort */ }
  }
  return true;
}

/**
 * Izmena metadata (opis, kategorija) — binarni sadržaj se ne menja.
 * @param {string} id
 * @param {{ category?: string, description?: string }} patch
 */
export async function patchMaintMachineFile(id, patch) {
  if (!id) return null;
  const body = {};
  if (patch?.category !== undefined) body.category = patch.category ? String(patch.category).slice(0, 40) : null;
  if (patch?.description !== undefined) body.description = patch.description ? String(patch.description).slice(0, 500) : null;
  if (!Object.keys(body).length) return null;
  const params = new URLSearchParams();
  params.set('id', `eq.${id}`);
  const res = await sbReq(`maint_machine_files?${params.toString()}`, 'PATCH', body);
  return Array.isArray(res) ? (res[0] || null) : (res || null);
}

/* ── Radni nalozi (maint_work_orders) — add_maint_work_orders.sql ───────── */

const MAINT_WO_LIST_COLS =
  'wo_id,wo_number,title,status,priority,type,created_at,assigned_to,source_incident_id,asset_id,description,safety_marker,due_at';

/**
 * Lista radnih naloga vidljivih korisniku (RLS). Ugnježđen `maint_assets` za šifru/naziv.
 * @param {{ limit?: number, statusIn?: string[] }} [opts]
 * @returns {Promise<Array<object>|null>}
 */
export async function fetchMaintWorkOrders(opts = {}) {
  const limit = Math.min(opts.limit ?? 400, 1000);
  const parts = [
    `select=${MAINT_WO_LIST_COLS},maint_assets(asset_code,name,asset_type)`,
    'order=created_at.desc',
    `limit=${limit}`,
  ];
  if (Array.isArray(opts.statusIn) && opts.statusIn.length) {
    const inList = opts.statusIn.map(s => enc(String(s).trim())).filter(Boolean);
    if (inList.length) {
      parts.push(`status=in.(${inList.join(',')})`);
    }
  }
  return await sbReq(`maint_work_orders?${parts.join('&')}`);
}

/**
 * @param {string} woId uuid
 * @returns {Promise<object|null>}
 */
export async function fetchMaintWorkOrderById(woId) {
  const rows = await sbReq(
    `maint_work_orders?select=${MAINT_WO_LIST_COLS},maint_assets(asset_code,name,asset_type)&wo_id=eq.${encodeURIComponent(woId)}&limit=1`,
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/**
 * @param {string} incidentId uuid
 * @returns {Promise<object|null>}
 */
export async function fetchMaintWorkOrderByIncidentId(incidentId) {
  if (!incidentId) return null;
  const rows = await sbReq(
    `maint_work_orders?select=${MAINT_WO_LIST_COLS},maint_assets(asset_code,name,asset_type)&source_incident_id=eq.${encodeURIComponent(incidentId)}&order=created_at.desc&limit=1`,
  ).catch(() => null);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/**
 * @param {string} woId
 * @param {Record<string, unknown>} fields npr. status, assigned_to, started_at, completed_at, closure_comment
 * @returns {Promise<boolean>}
 */
export async function patchMaintWorkOrder(woId, fields) {
  const body = { ...fields };
  delete body.wo_id;
  delete body.created_at;
  body.updated_by = getCurrentUser()?.id || null;
  const r = await sbReq(`maint_work_orders?wo_id=eq.${encodeURIComponent(woId)}`, 'PATCH', body);
  return r !== null;
}

/**
 * @param {string} woId uuid
 * @returns {Promise<Array<object>>}
 */
export async function fetchMaintWorkOrderEvents(woId) {
  if (!woId) return [];
  const rows = await sbReq(
    `maint_wo_events?select=*&wo_id=eq.${encodeURIComponent(woId)}&order=at.desc&limit=200`,
  ).catch(() => null);
  return Array.isArray(rows) ? rows : [];
}

/**
 * @param {string} woId uuid
 * @returns {Promise<Array<object>>}
 */
export async function fetchMaintWorkOrderParts(woId) {
  if (!woId) return [];
  const rows = await sbReq(
    `maint_wo_parts?select=*&wo_id=eq.${encodeURIComponent(woId)}&order=created_at.desc&limit=200`,
  ).catch(() => null);
  return Array.isArray(rows) ? rows : [];
}

/**
 * @param {string} woId uuid
 * @returns {Promise<Array<object>>}
 */
export async function fetchMaintWorkOrderLabor(woId) {
  if (!woId) return [];
  const rows = await sbReq(
    `maint_wo_labor?select=*&wo_id=eq.${encodeURIComponent(woId)}&order=created_at.desc&limit=200`,
  ).catch(() => null);
  return Array.isArray(rows) ? rows : [];
}

/**
 * @param {{ wo_id: string, part_name: string, quantity?: number|null, unit?: string|null, unit_cost?: number|null, supplier?: string|null }} payload
 * @returns {Promise<object|null>}
 */
export async function insertMaintWorkOrderPart(payload) {
  const partName = String(payload.part_name || '').trim();
  if (!payload.wo_id || !partName) return null;
  const rows = await sbReq('maint_wo_parts', 'POST', {
    wo_id: payload.wo_id,
    part_name: partName,
    quantity: payload.quantity ?? null,
    unit: payload.unit || null,
    unit_cost: payload.unit_cost ?? null,
    supplier: payload.supplier || null,
  }).catch(() => null);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/**
 * @param {{ wo_id: string, minutes: number, notes?: string|null }} payload
 * @returns {Promise<object|null>}
 */
export async function insertMaintWorkOrderLabor(payload) {
  const minutes = Number(payload.minutes || 0);
  if (!payload.wo_id || !Number.isFinite(minutes) || minutes <= 0) return null;
  const rows = await sbReq('maint_wo_labor', 'POST', {
    wo_id: payload.wo_id,
    technician_id: getCurrentUser()?.id || null,
    minutes: Math.round(minutes),
    notes: payload.notes || null,
  }).catch(() => null);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/**
 * @param {{ wo_id: string, event_type: string, comment?: string|null, from_value?: string|null, to_value?: string|null }} payload
 * @returns {Promise<object|null>}
 */
export async function insertMaintWorkOrderEvent(payload) {
  const rows = await sbReq('maint_wo_events', 'POST', {
    wo_id: payload.wo_id,
    actor: getCurrentUser()?.id || null,
    event_type: payload.event_type,
    from_value: payload.from_value ?? null,
    to_value: payload.to_value ?? null,
    comment: payload.comment || null,
  }).catch(() => null);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/**
 * `maint_machines.machine_code` po `asset_id` (katalog ↔ CMMS sredstvo).
 * @param {string} assetId uuid
 * @returns {Promise<string|null>}
 */
export async function fetchMachineCodeByAssetId(assetId) {
  if (!assetId) return null;
  const rows = await sbReq(
    `maint_machines?select=machine_code&asset_id=eq.${encodeURIComponent(assetId)}&archived_at=is.null&limit=1`,
  ).catch(() => null);
  if (Array.isArray(rows) && rows[0]?.machine_code) {
    return String(rows[0].machine_code);
  }
  return null;
}

/* ── Hijerarhija lokacija (maint_locations) — add_maint_locations.sql ───── */

const MAINT_LOCATION_COLS =
  'location_id,parent_location_id,location_type,code,name,active,created_at,updated_at';

/**
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<Array<object>|null>}
 */
export async function fetchMaintLocations(opts = {}) {
  const limit = opts.limit ?? 2000;
  return await sbReq(
    `maint_locations?select=${MAINT_LOCATION_COLS}&order=name.asc&limit=${limit}`,
  );
}

/**
 * @param {{ name: string, code?: string | null, location_type?: string, parent_location_id?: string | null, active?: boolean }} payload
 * @returns {Promise<object|null>}
 */
export async function insertMaintLocation(payload) {
  const name = String(payload.name || '').trim();
  if (!name) return null;
  const body = {
    name,
    code: payload.code != null && String(payload.code).trim() ? String(payload.code).trim() : null,
    location_type: (payload.location_type && String(payload.location_type).trim()) || 'lokacija',
    parent_location_id: payload.parent_location_id || null,
    active: payload.active !== false,
  };
  const rows = await sbReq('maint_locations', 'POST', body, { upsert: false });
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/**
 * @param {string} locationId UUID
 * @param {Record<string, unknown>} patch
 * @returns {Promise<boolean>}
 */
export async function patchMaintLocation(locationId, patch) {
  if (!locationId) return false;
  const body = { ...patch };
  delete body.location_id;
  delete body.created_at;
  if (!Object.keys(body).length) return false;
  const r = await sbReq(
    `maint_locations?location_id=eq.${enc(locationId)}`,
    'PATCH',
    body,
  );
  return r !== null;
}
