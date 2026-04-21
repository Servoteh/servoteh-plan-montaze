/**
 * Servisi za modul održavanje mašina (Supabase REST).
 * Zavisi od migracije sql/migrations/add_maintenance_module.sql.
 */

import { sbReq, getSupabaseUrl, getSupabaseAnonKey } from './supabase.js';
import { getCurrentUser } from '../state/auth.js';

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
 * @param {string} machineCode
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<Array<object>|null>}
 */
export async function fetchMaintIncidentsForMachine(machineCode, opts = {}) {
  const lim = opts.limit ?? 30;
  return await sbReq(
    `maint_incidents?select=id,title,severity,status,reported_at,assigned_to&machine_code=eq.${enc(machineCode)}&order=reported_at.desc&limit=${lim}`
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
    reported_by: uid,
    title: payload.title,
    description: payload.description || null,
    severity: payload.severity,
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
  const rows = await sbReq(`maint_incidents?select=*&id=eq.${encodeURIComponent(incidentId)}&limit=1`);
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

/* ── Katalog mašina (maint_machines) ─────────────────────────────────────── */

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
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
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
  try {
    const r = await fetch(
      `${baseUrl}/storage/v1/object/sign/${MAINT_FILES_BUCKET}/${encodeURI(storagePath)}`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'apikey': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expiresIn: expiresSec }),
      },
    );
    if (!r.ok) return null;
    const { signedURL, signedUrl } = await r.json();
    const rel = signedURL || signedUrl;
    if (!rel) return null;
    return baseUrl + '/storage/v1' + (rel.startsWith('/') ? rel : '/' + rel);
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
