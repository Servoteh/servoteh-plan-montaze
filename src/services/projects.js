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

/* Isti princip kao phase_type: ako DB nema `description` kolonu,
   posle prvog neuspelog upserta je isključujemo za tu sesiju. */
let phaseDescriptionSchemaSupported = true;
export function setPhaseDescriptionSchemaSupported(v) {
  phaseDescriptionSchemaSupported = !!v;
}

/* Isti princip: ako DB nema `linked_drawings` jsonb kolonu (migracija
   `add_phases_linked_drawings.sql` nije pokrenuta), isključujemo je za sesiju
   da se ostali save-ovi ne ruše. */
let phaseLinkedDrawingsSchemaSupported = true;
export function setPhaseLinkedDrawingsSchemaSupported(v) {
  phaseLinkedDrawingsSchemaSupported = !!v;
}

/* Isto za WP.assembly_drawing_no (migracija `add_wp_assembly_drawing.sql`).
   Ako kolona ne postoji, isključujemo je za sesiju. */
let wpAssemblyDrawingSchemaSupported = true;
export function setWpAssemblyDrawingSchemaSupported(v) {
  wpAssemblyDrawingSchemaSupported = !!v;
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
    /* Glavni crtež sklopa za ceo WP („veza sa" na nivou naloga montaže).
       Tolerantno: ako kolona još ne postoji u DB-u, ostaje ''. */
    assemblyDrawingNo: typeof d.assembly_drawing_no === 'string' ? d.assembly_drawing_no : '',
    phases: [],
  };
}

export function mapDbPhase(d) {
  /* phase_type kolona je opciona — fallback: detektuj iz imena faze. */
  const rawType = d.phase_type
    || (String(d.phase_name || '').toLowerCase().includes('elektro') ? 'electrical' : 'mechanical');
  /* `linked_drawings` je niz stringova; tolerantno parsiraj — ako je bilo
     kojom (legacy) greškom snimljen kao non-array, vrati []. */
  const ld = Array.isArray(d.linked_drawings)
    ? d.linked_drawings.filter(x => typeof x === 'string' && x.trim() !== '')
    : [];
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
    description: d.description || '',
    type: normalizePhaseType(rawType),
    linkedDrawings: ld,
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
  const base = {
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
  if (wpAssemblyDrawingSchemaSupported) {
    base.assembly_drawing_no = String(wp.assemblyDrawingNo || '').trim();
  }
  return base;
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
  if (phaseDescriptionSchemaSupported) {
    base.description = ph.description || '';
  }
  if (phaseLinkedDrawingsSchemaSupported) {
    /* Sanitize: niz stringova, trim, deduplicate (case-sensitive jer su
       drawing_no tehnički ključevi). */
    const seen = new Set();
    const arr = Array.isArray(ph.linkedDrawings) ? ph.linkedDrawings : [];
    base.linked_drawings = arr.reduce((acc, v) => {
      const s = String(v == null ? '' : v).trim();
      if (s && !seen.has(s)) { seen.add(s); acc.push(s); }
      return acc;
    }, []);
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
  if (!data) return null;
  /* Schema reactivation: ako je u response-u barem jedan red sa poljem
     `assembly_drawing_no`, kolona postoji u DB-u → uključi flag nazad
     (pokrije slučaj kada je flag bio isključen pre primene migracije). */
  if (data.length > 0 && Object.prototype.hasOwnProperty.call(data[0], 'assembly_drawing_no')) {
    if (!wpAssemblyDrawingSchemaSupported) {
      wpAssemblyDrawingSchemaSupported = true;
      console.info('[wp.assembly_drawing_no] Column detected in DB; re-enabling save support.');
    }
  }
  return data.map(mapDbWP);
}

export async function loadPhasesFromDb(projectId, wpId) {
  if (!getIsOnline()) return null;
  const data = await sbReq('phases?work_package_id=eq.' + wpId + '&order=sort_order');
  if (!data) return null;
  if (data.length > 0) {
    const sample = data[0];
    if (Object.prototype.hasOwnProperty.call(sample, 'linked_drawings') && !phaseLinkedDrawingsSchemaSupported) {
      phaseLinkedDrawingsSchemaSupported = true;
      console.info('[phase.linked_drawings] Column detected in DB; re-enabling save support.');
    }
    if (Object.prototype.hasOwnProperty.call(sample, 'description') && !phaseDescriptionSchemaSupported) {
      phaseDescriptionSchemaSupported = true;
      console.info('[phase.description] Column detected in DB; re-enabling save support.');
    }
    if (Object.prototype.hasOwnProperty.call(sample, 'phase_type') && !phaseTypeSchemaSupported) {
      phaseTypeSchemaSupported = true;
      console.info('[phase.phase_type] Column detected in DB; re-enabling save support.');
    }
  }
  return data.map(mapDbPhase);
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
  let payload = buildWPPayload(wp, projectId);
  let res = await sbReq('work_packages', 'POST', payload);
  if (res === null && payload.assembly_drawing_no !== undefined) {
    /* Per-call fallback: ako kolona `assembly_drawing_no` ne postoji u DB-u,
       izbaci je i pokušaj ponovo. NAMERNO ne setujemo globalni flag na false
       — sledeći save opet pokušava sa puno polje. Time se izbegava trajno
       „zaglavljivanje" sesije ako je migracija primenjena u međuvremenu. */
    const { assembly_drawing_no, ...rest } = payload;
    payload = rest;
    res = await sbReq('work_packages', 'POST', payload);
    if (res !== null) {
      console.warn('[wp.assembly_drawing_no] Column not present in DB; skipping for this call. Apply sql/migrations/add_wp_assembly_drawing.sql to enable.');
    }
  }
  return res;
}

export async function savePhaseToDb(ph, projectId, wpId, sortOrder) {
  if (!getIsOnline() || !canEdit()) return null;
  let payload = buildPhasePayload(ph, projectId, wpId, sortOrder);
  let res = await sbReq('phases', 'POST', payload);
  if (res === null && payload.phase_type !== undefined) {
    /* Per-call fallback (vidi komentar gore u saveWorkPackageToDb). */
    const { phase_type, ...rest } = payload;
    payload = rest;
    res = await sbReq('phases', 'POST', payload);
    if (res !== null) {
      console.warn('[phase_type] Column not present in DB; skipping for this call. Apply sql/migrations/add_phase_type.sql to enable.');
    }
  }
  if (res === null && payload.description !== undefined) {
    const { description, ...rest } = payload;
    payload = rest;
    res = await sbReq('phases', 'POST', payload);
    if (res !== null) {
      console.warn('[phase.description] Column not present in DB; skipping for this call. Apply sql/migrations/add_phase_description.sql to enable.');
    }
  }
  if (res === null && payload.linked_drawings !== undefined) {
    const { linked_drawings, ...rest } = payload;
    payload = rest;
    res = await sbReq('phases', 'POST', payload);
    if (res !== null) {
      console.warn('[phase.linked_drawings] Column not present in DB; skipping for this call. Apply sql/migrations/add_phases_linked_drawings.sql to enable.');
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
