/**
 * Contracts CRUD — Supabase REST.
 * Bit-paritet sa legacy/index.html mapDbContract + buildContractPayload + load/save/update/delete.
 */

import { sbReq } from './supabase.js';
import { canEdit, getIsOnline } from '../state/auth.js';

export function mapDbContract(d) {
  return {
    id: d.id,
    employeeId: d.employee_id,
    type: d.contract_type || 'neodredjeno',
    number: d.contract_number || '',
    position: d.position || '',
    dateFrom: d.date_from || '',
    dateTo: d.date_to || '',
    isActive: d.is_active !== false,
    note: d.note || '',
    createdAt: d.created_at || null,
    updatedAt: d.updated_at || null,
  };
}

export function buildContractPayload(c) {
  const p = {
    employee_id: c.employeeId,
    contract_type: c.type || 'neodredjeno',
    contract_number: c.number || '',
    position: c.position || '',
    date_from: c.dateFrom || null,
    date_to: c.dateTo || null,
    is_active: c.isActive !== false,
    note: c.note || '',
    updated_at: new Date().toISOString(),
  };
  if (c.id) p.id = c.id;
  return p;
}

export async function loadContractsFromDb() {
  if (!getIsOnline()) return null;
  const data = await sbReq('contracts?select=*&order=date_from.desc.nullslast');
  if (!data) return null;
  return data.map(mapDbContract);
}

export async function saveContractToDb(c) {
  if (!getIsOnline() || !canEdit()) return null;
  const res = await sbReq('contracts', 'POST', buildContractPayload(c));
  if (res === null) console.warn('[kadrovska] contracts save failed — run sql/migrations/add_kadrovska_phase1.sql');
  return res;
}

export async function updateContractInDb(c) {
  if (!getIsOnline() || !canEdit() || !c.id) return null;
  const { id, ...rest } = buildContractPayload(c);
  return await sbReq(`contracts?id=eq.${encodeURIComponent(c.id)}`, 'PATCH', rest);
}

export async function deleteContractFromDb(id) {
  if (!getIsOnline() || !canEdit() || !id) return false;
  return (await sbReq(`contracts?id=eq.${encodeURIComponent(id)}`, 'DELETE')) !== null;
}
