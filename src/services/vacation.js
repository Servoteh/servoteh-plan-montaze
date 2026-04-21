/**
 * Godišnji odmor — entitlements + saldo (Faza K2).
 *
 * Dve stvari:
 *   1) `vacation_entitlements` — po zaposlenom po godini: default 20 dana,
 *      plus opcioni ručno prenos (`days_carried_over`) iz prošle godine.
 *   2) `v_vacation_balance` — read-only view: used_days i days_remaining.
 *
 * Izveštajni use-case: lista svih zaposlenih sa preostalim danima za godinu X.
 *
 * RLS: SELECT za sve authenticated; INSERT/UPDATE/DELETE preko `has_edit_role()`
 * tj. svako ko ima pristup kadrovskoj + canEdit ili HR.
 */

import { sbReq } from './supabase.js';
import { canEditKadrovska, getIsOnline } from '../state/auth.js';

/** Entitlement row mapper. */
export function mapDbEntitlement(d) {
  return {
    id: d.id,
    employeeId: d.employee_id,
    year: Number(d.year),
    daysTotal: Number(d.days_total ?? 20),
    daysCarriedOver: Number(d.days_carried_over ?? 0),
    note: d.note || '',
    createdAt: d.created_at || null,
    updatedAt: d.updated_at || null,
  };
}

function buildEntPayload(e) {
  const p = {
    employee_id: e.employeeId,
    year: Number(e.year),
    days_total: Number(e.daysTotal ?? 20),
    days_carried_over: Number(e.daysCarriedOver ?? 0),
    note: e.note || '',
    updated_at: new Date().toISOString(),
  };
  if (e.id) p.id = e.id;
  return p;
}

export function mapDbBalance(d) {
  return {
    employeeId: d.employee_id,
    year: Number(d.year ?? 0),
    daysTotal: Number(d.days_total ?? 0),
    daysCarriedOver: Number(d.days_carried_over ?? 0),
    daysUsed: Number(d.days_used ?? 0),
    daysRemaining: Number(d.days_remaining ?? 0),
  };
}

/** Učitaj SVE entitlement redove (svi zaposleni × sve godine). */
export async function loadEntitlementsFromDb() {
  if (!getIsOnline()) return null;
  const data = await sbReq('vacation_entitlements?select=*&order=year.desc,employee_id');
  if (!data) return null;
  return data.map(mapDbEntitlement);
}

/** Saldo (used/remaining) — opcioni filter po godini. */
export async function loadBalancesFromDb(year = null) {
  if (!getIsOnline()) return null;
  let q = 'v_vacation_balance?select=*';
  if (year) q += `&year=eq.${encodeURIComponent(year)}`;
  const data = await sbReq(q);
  if (!data) return null;
  return data.map(mapDbBalance);
}

/**
 * Upsert entitlement (jedinstven po (employee_id, year)).
 * Koristi merge-duplicates preko sbReq default-a.
 */
export async function saveEntitlementToDb(e) {
  if (!getIsOnline() || !canEditKadrovska()) return null;
  const res = await sbReq(
    'vacation_entitlements?on_conflict=employee_id,year',
    'POST',
    buildEntPayload(e),
  );
  if (res === null) {
    console.warn('[kadrovska] Entitlement save failed — run add_kadr_employee_extended.sql');
  }
  return res;
}

export async function updateEntitlementInDb(e) {
  if (!getIsOnline() || !canEditKadrovska() || !e.id) return null;
  const { id, ...rest } = buildEntPayload(e);
  return await sbReq(
    `vacation_entitlements?id=eq.${encodeURIComponent(e.id)}`,
    'PATCH',
    rest,
  );
}

export async function deleteEntitlementFromDb(id) {
  if (!getIsOnline() || !canEditKadrovska() || !id) return false;
  return (await sbReq(
    `vacation_entitlements?id=eq.${encodeURIComponent(id)}`,
    'DELETE',
  )) !== null;
}
