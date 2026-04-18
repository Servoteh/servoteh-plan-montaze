/**
 * user_roles CRUD service (admin only).
 *
 * Bezbednosna odluka (port iz legacy/index.html, 2026-04-18):
 *   - INSERT iz UI-ja je SVESNO ONEMOGUĆEN. Razlog: dodeljivanje role pre
 *     nego što Auth nalog postoji znači da bi taj email — kad/ako se Auth
 *     nalog kasnije napravi — odmah dobio dodeljenu rolu (npr. admin).
 *     Ovaj rizik se uklanja tako što se nove uloge dodaju iz Supabase SQL
 *     Editor-a (audit trail). RLS politika dodatno blokira INSERT preko
 *     non-admin tokena.
 *   - Edit i Delete za POSTOJEĆE redove ostaju — admin može menjati rolu,
 *     deaktivirati nalog, brisati red.
 *
 * Mapping: DB snake_case (email, full_name, project_id, is_active,
 * must_change_password, created_at, updated_at, created_by) → JS camelCase.
 */

import { sbReq } from './supabase.js';
import { canManageUsers, getCurrentUser } from '../state/auth.js';
import { showToast } from '../lib/dom.js';

export function mapDbUser(d) {
  return {
    id: d.id,
    email: String(d.email || '').toLowerCase().trim(),
    fullName: d.full_name || '',
    team: d.team || '',
    role: String(d.role || 'viewer').toLowerCase(),
    projectId: d.project_id || null,
    isActive: d.is_active !== false,
    mustChangePassword: d.must_change_password === true,
    createdAt: d.created_at || null,
    updatedAt: d.updated_at || null,
    createdBy: d.created_by || '',
  };
}

export function buildUserPayload(u) {
  const cu = getCurrentUser();
  const p = {
    email: String(u.email || '').toLowerCase().trim(),
    role: String(u.role || 'viewer').toLowerCase(),
    project_id: u.projectId || null,
    is_active: u.isActive !== false,
    full_name: u.fullName || '',
    team: u.team || '',
    updated_at: new Date().toISOString(),
    created_by: String(cu?.email || '').toLowerCase(),
  };
  if (u.id) p.id = u.id;
  return p;
}

/** SELECT svih user_roles redova. Vraća null ako request padne. */
export async function loadUsersFromDb() {
  return await sbReq('user_roles?select=*&order=role.asc,email.asc');
}

/**
 * UPDATE postojeceg user_role reda. INSERT je svesno blokiran u UI-ju —
 * ako se prosledi `u` bez `id`, vraćamo null + console.warn.
 */
export async function saveUserToDb(u) {
  if (!canManageUsers()) return null;
  const payload = buildUserPayload(u);
  if (u.id) {
    return await sbReq(
      `user_roles?id=eq.${encodeURIComponent(u.id)}`,
      'PATCH',
      payload,
    );
  }
  console.warn('[saveUserToDb] INSERT blocked from UI. Add new roles via Supabase SQL Editor.');
  showToast('ℹ Nove uloge se dodaju isključivo kroz Supabase SQL Editor.');
  return null;
}

/** DELETE user_role reda. Vraća true/false. */
export async function deleteUserRoleFromDb(id) {
  if (!canManageUsers()) return false;
  return (await sbReq(`user_roles?id=eq.${encodeURIComponent(id)}`, 'DELETE')) !== null;
}
