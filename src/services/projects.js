/**
 * Projects + Work Packages + Phases — Supabase REST.
 *
 * Bit-paritet sa legacy/index.html (DB ↔ STATE MAPPERS i DB LOAD/SAVE
 * sekcije). UI-jevi (Plan Montaže, Gantt, Total Gantt) se grade na
 * objektima vraćenim ovde (projekat → workPackages → phases).
 *
 * Schema-fallback strategija za phase_type:
 *   ako prvi POST sa `phase_type` vrati null (kolona ne postoji),
 *   trajno isključi `phase_type` u tom session-u (allData._phaseTypeSchemaSupported).
 *   Ovo se ovde čuva kao modulski flag `phaseTypeSchemaSupported`.
 */

import { sbReq } from './supabase.js';
import { canEdit, getIsOnline, getCurrentUser } from '../state/auth.js';
import { DEFAULT_LOCATIONS, NUM_CHECKS } from '../lib/constants.js';

let phaseTypeSchemaSupported = true;

export function setPhaseTypeSchemaSupported(v) {
  phaseTypeSchemaSupported = !!v;
}
export function isPhaseTypeSchemaSupported() {
  return phaseTypeSchemaSupported;
}

export function normalizePhaseType(t) {
  const v = String(t || '').toLowerCase();
  return v === 'electrical' || v === 'elektro' || v === 'e' ? 'electrical' : 'mechanical';
}

/* ── Mappers DB → State ── */
export function mapDbProject(d) {
  return {
    id: d.id,
    code: d.project_code || '',
    name: d.project_name || '',
    projectM: d.projectm || '',
    deadline: d.project_deadline || '',
    pmEmail: d.pm_email || '',
    leadPmEmail: d.leadpm_email || '',
    reminderEnabled: !!d.reminder_enabled,
    status: d.status || 'active',
    locations: Array.isArray(d.locations) && d.locations.length
      ? d.locations.slice()
      : DEFAULT_LOCATIONS.slice(),
    workPackages: [],
  };
}

export function mapDbWP(d) {
  return {
    id: d.id,
    projectId: d.project_id,
    rnCode: d.rn_code || '',
    rnOrder: d.rn_order || 1,
    name: d.name || '',
    location: d.location || 'Dobanovci',
    defaultEngineer: d.responsible_engineer_default || '',
    defaultLead: d.montage_lead_default || '',
    deadline: d.deadline || '',
    isActive: d.is_active !== false,
    phases: [],
  };
}

export function mapDbPhase(d) {
  /* phase_type kolona je opciona — fallback: detektuj iz imena faze. */
  const rawType = d.phase_type
    || (String(d.phase_name || '').toLowerCase().includes('elektro') ? 'electrical' : 'mechanical');
  return {
    id: d.id,
    projectId: d.project_id,
    wpId: d.work_package_id,
    name: d.phase_name || '',
    loc: d.location || 'Dobanovci',
    start: d.start_date,
    end: d.end_date,
    engineer: d.responsible_engineer || '',
    person: d.montage_lead || '',
    status: d.status || 0,
    pct: d.pct || 0,
    checks: d.checks || new Array(NUM_CHECKS).fill(false),
    note: d.note || '',
    blocker: d.blocker || '',
    type: normalizePhaseType(rawType),
  };
}

/* ── Payload builders State → DB ── */
export function buildProjectPayload(p) {
  return {
    id: p.id,
    project_code: p.code,
    project_name: p.name,
    projectm: p.projectM,
    project_deadline: p.deadline || null,
    pm_email: p.pmEmail,
    leadpm_email: p.leadPmEmail,
    reminder_enabled: p.reminderEnabled,
    status: p.status,
    updated_at: new Date().toISOString(),
  };
}

export function buildWPPayload(wp, projectId) {
  return {
    id: wp.id,
    project_id: projectId,
    rn_code: wp.rnCode,
    rn_order: wp.rnOrder,
    name: wp.name,
    location: wp.location,
    responsible_engineer_default: wp.defaultEngineer,
    montage_lead_default: wp.defaultLead,
    deadline: wp.deadline || null,
    sort_order: wp.rnOrder,
    is_active: wp.isActive,
    updated_at: new Date().toISOString(),
  };
}

export function buildPhasePayload(ph, projectId, wpId, sortOrder) {
  const base = {
    id: ph.id,
    project_id: projectId,
    work_package_id: wpId,
    phase_name: ph.name,
    location: ph.loc,
    start_date: ph.start || null,
    end_date: ph.end || null,
    responsible_engineer: ph.engineer,
    montage_lead: ph.person,
    status: ph.status,
    pct: ph.pct,
    checks: ph.checks,
    blocker: ph.blocker,
    note: ph.note,
    sort_order: sortOrder,
    updated_at: new Date().toISOString(),
    updated_by: getCurrentUser()?.email || '',
  };
  if (phaseTypeSchemaSupported) {
    base.phase_type = normalizePhaseType(ph.type);
  }
  return base;
}

/* ── Loaders ── */
export async function loadProjectsFromDb() {
  if (!getIsOnline()) return null;
  const data = await sbReq('projects?select=*&order=created_at');
  return data ? data.map(mapDbProject) : null;
}

export async function loadWorkPackagesFromDb(projectId) {
  if (!getIsOnline()) return null;
  const data = await sbReq('work_packages?project_id=eq.' + projectId + '&order=sort_order');
  return data ? data.map(mapDbWP) : null;
}

export async function loadPhasesFromDb(projectId, wpId) {
  if (!getIsOnline()) return null;
  const data = await sbReq('phases?work_package_id=eq.' + wpId + '&order=sort_order');
  return data ? data.map(mapDbPhase) : null;
}

/** Učitaj WP-ove + faze za sve WP-ove. Vraća niz WP objekata sa popunjenim `phases`. */
export async function loadAllProjectData(projectId) {
  const wps = await loadWorkPackagesFromDb(projectId);
  if (!wps) return null;
  for (const wp of wps) {
    const phases = await loadPhasesFromDb(projectId, wp.id);
    wp.phases = phases || [];
  }
  return wps;
}

/* ── Savers (UPSERT preko POST + merge-duplicates) ── */
export async function saveProjectToDb(proj) {
  if (!getIsOnline() || !canEdit()) return null;
  return await sbReq('projects', 'POST', buildProjectPayload(proj));
}

export async function saveWorkPackageToDb(wp, projectId) {
  if (!getIsOnline() || !canEdit()) return null;
  return await sbReq('work_packages', 'POST', buildWPPayload(wp, projectId));
}

export async function savePhaseToDb(ph, projectId, wpId, sortOrder) {
  if (!getIsOnline() || !canEdit()) return null;
  let payload = buildPhasePayload(ph, projectId, wpId, sortOrder);
  let res = await sbReq('phases', 'POST', payload);
  if (res === null && payload.phase_type !== undefined && phaseTypeSchemaSupported) {
    /* Fallback: kolona phase_type ne postoji — isključi je i probaj ponovo. */
    setPhaseTypeSchemaSupported(false);
    const { phase_type, ...rest } = payload;
    res = await sbReq('phases', 'POST', rest);
    if (res !== null) {
      console.warn('[phase_type] Column not present in DB; skipping phase_type. Apply sql/migrations/add_phase_type.sql to enable.');
    }
  }
  return res;
}

export async function deletePhaseFromDb(phaseId) {
  if (!getIsOnline() || !phaseId) return false;
  return (await sbReq(`phases?id=eq.${phaseId}`, 'DELETE')) !== null;
}

export async function deleteWorkPackageFromDb(wpId) {
  if (!getIsOnline() || !wpId) return false;
  return (await sbReq(`work_packages?id=eq.${wpId}`, 'DELETE')) !== null;
}

export async function deleteProjectFromDb(projectId) {
  if (!getIsOnline() || !projectId) return false;
  return (await sbReq(`projects?id=eq.${projectId}`, 'DELETE')) !== null;
}
