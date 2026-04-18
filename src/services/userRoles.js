/**
 * Dohvatanje user_roles redova za trenutno ulogovanog korisnika +
 * mapiranje u efektivnu rolu.
 *
 * Bit-paritetan port iz legacy/index.html:loadUserRoleMatchesFromDb +
 * effectiveRoleFromMatches. Strategija:
 *   1) Probaj direktan SELECT po email-u (eq.lowercase, eq.raw, ilike *case*).
 *   2) Ako svi direktni padnu (HTTP fail), fallback na SECURITY DEFINER RPC
 *      get_my_user_roles (postoji od enable_user_roles_rls_proper.sql).
 *   3) Ako i RPC padne — postavi flag i vrati prazan niz.
 *
 * Posle migracije cleanup_user_roles_legacy_policies.sql, RLS dozvoljava
 * direktan SELECT na svoj red (`user_roles_read_self`), pa ovo radi i bez RPC-a.
 */

import { sbReq } from './supabase.js';
import {
  getCurrentUser,
  setLastUserRolesQueryFailed,
  setRole,
} from '../state/auth.js';

export async function loadUserRoleMatchesFromDb() {
  const currentUser = getCurrentUser();
  if (!currentUser) {
    setLastUserRolesQueryFailed(false);
    return [];
  }
  setLastUserRolesQueryFailed(false);

  const emailNorm = String(currentUser.email || '').trim().toLowerCase();
  const emailRaw = String(currentUser.emailRaw || '').trim();

  /* PostgREST quirks:
       - eq.lowercase je obično dovoljno
       - eq.raw za nestandardne kapitalizacije
       - ilike *email* kao case-insensitive backup */
  const filters = [];
  filters.push('email=eq.' + encodeURIComponent(emailNorm));
  if (emailRaw && emailRaw !== emailNorm) {
    filters.push('email=eq.' + encodeURIComponent(emailRaw));
  }
  filters.push('email=ilike.' + encodeURIComponent('*' + emailNorm + '*'));

  let collected = [];
  let anyQuerySucceeded = false;

  for (let fi = 0; fi < filters.length; fi++) {
    const path = 'user_roles?is_active=eq.true&' + filters[fi] + '&select=email,role,project_id';
    const data = await sbReq(path);
    if (data === null) {
      console.error('[user_roles] Filter ' + fi + ' failed (HTTP/parse error). Trying next filter.', { path });
      continue;
    }
    anyQuerySucceeded = true;
    if (!Array.isArray(data)) continue;
    collected = collected.concat(data);
    if (collected.length > 0) break;
  }

  if (!anyQuerySucceeded) {
    console.warn('[user_roles] All direct SELECT-s failed; trying RPC get_my_user_roles fallback…');
    const rpcData = await sbReq('rpc/get_my_user_roles', 'POST', {});
    if (Array.isArray(rpcData)) {
      collected = rpcData;
      setLastUserRolesQueryFailed(false);
    } else {
      setLastUserRolesQueryFailed(true);
      console.error('[user_roles] Both direct SELECT and RPC fallback failed.');
      return [];
    }
  }

  const normRow = r => ({
    ...r,
    email: String(r.email || '').trim().toLowerCase(),
    role: String(r.role || '').trim().toLowerCase(),
  });
  const seen = new Set();
  const unique = collected.map(normRow).filter(r => {
    const k = r.email + '|' + r.role + '|' + String(r.project_id ?? '');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  /* Ilike fallback može povući druge email-ove → strogo filtriraj. */
  return unique.filter(r => r.email === emailNorm);
}

/** Prioritet: admin > leadpm > pm > hr > viewer. */
export function effectiveRoleFromMatches(matches) {
  if (!matches || matches.length === 0) return 'viewer';
  const norm = matches.map(r => String(r.role || '').trim().toLowerCase());
  if (norm.includes('admin')) return 'admin';
  if (norm.includes('leadpm')) return 'leadpm';
  if (norm.includes('pm')) return 'pm';
  if (norm.includes('hr')) return 'hr';
  if (norm.includes('viewer')) return 'viewer';
  console.warn('Unknown roles found in user_roles:', matches);
  return 'viewer';
}

/** Convenience: učita matches i postavi rolu u state. */
export async function loadAndApplyUserRole() {
  const matches = await loadUserRoleMatchesFromDb();
  const role = effectiveRoleFromMatches(matches);
  setRole(role);
  return { role, matches };
}
