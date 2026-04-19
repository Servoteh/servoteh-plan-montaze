/**
 * Projekti — Supabase REST service za potrebe modula Sastanci.
 *
 * Koristi POSTOJEĆU `projects` tabelu (Plan Montaže) kao izvor svih
 * "projekata" u sistemu. Plus dodatna tabela `projekt_bigtehn_rn` za
 * opciono mapiranje na BigTehn radne naloge (M:N).
 *
 * NAPOMENA: services/projects.js već postoji i radi sa Plan Montaže
 * stejt-om. Ovde držimo samo "lite" verziju (id + label) koja je
 * potrebna sastancima — bez WP/phases učitavanja.
 */

import { sbReq } from './supabase.js';
import { getIsOnline } from '../state/auth.js';

export function mapProjekatLite(d) {
  if (!d) return null;
  /* Composite label: "RN 9400 - Kovačka linija" */
  const code = d.project_code || '';
  const name = d.project_name || '';
  const label = code && name ? `${code} - ${name}` : (code || name || '(bez imena)');
  return {
    id: d.id,
    code,
    name,
    label,
    deadline: d.project_deadline || null,
    status: d.status || 'active',
    pmEmail: d.pm_email || '',
    leadPmEmail: d.leadpm_email || '',
  };
}

/**
 * Lista svih aktivnih projekata. Sortirano po project_code (npr. RN 8069,
 * RN 9400 ...). Vraća lite verziju (id, code, name, label).
 */
export async function loadProjektiLite({ includeArchived = false } = {}) {
  if (!getIsOnline()) return [];
  let url = 'projects?select=id,project_code,project_name,project_deadline,status,pm_email,leadpm_email&order=project_code.asc.nullslast,project_name.asc';
  if (!includeArchived) url += '&status=neq.archived';
  const data = await sbReq(url);
  return Array.isArray(data) ? data.map(mapProjekatLite) : [];
}

export async function loadProjekat(id) {
  if (!id || !getIsOnline()) return null;
  const data = await sbReq(
    `projects?id=eq.${encodeURIComponent(id)}&select=id,project_code,project_name,project_deadline,status,pm_email,leadpm_email&limit=1`,
  );
  return Array.isArray(data) && data.length ? mapProjekatLite(data[0]) : null;
}

/* ── BigTehn RN veze ── */

export async function loadBigtehnRnsForProjekat(projekatId) {
  if (!projekatId || !getIsOnline()) return [];
  const data = await sbReq(
    `projekt_bigtehn_rn?projekat_id=eq.${encodeURIComponent(projekatId)}&select=bigtehn_rn_id,napomena`,
  );
  return Array.isArray(data) ? data.map(r => ({
    bigtehnRnId: r.bigtehn_rn_id,
    napomena: r.napomena || '',
  })) : [];
}

export async function addBigtehnRnToProjekat(projekatId, bigtehnRnId, napomena = '') {
  if (!projekatId || !bigtehnRnId || !getIsOnline()) return false;
  const payload = {
    projekat_id: projekatId,
    bigtehn_rn_id: Number(bigtehnRnId),
    napomena: napomena || null,
  };
  return (await sbReq('projekt_bigtehn_rn', 'POST', payload)) !== null;
}

export async function removeBigtehnRnFromProjekat(projekatId, bigtehnRnId) {
  if (!projekatId || !bigtehnRnId || !getIsOnline()) return false;
  const url = `projekt_bigtehn_rn?projekat_id=eq.${encodeURIComponent(projekatId)}`
    + `&bigtehn_rn_id=eq.${encodeURIComponent(bigtehnRnId)}`;
  return (await sbReq(url, 'DELETE')) !== null;
}
