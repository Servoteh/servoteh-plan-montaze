/**
 * Employees CRUD — Supabase REST + offline-safe wrappers.
 *
 * U Fazi K2 proširen set polja (vidi migraciju add_kadr_employee_extended.sql):
 *   * first_name, last_name, personal_id (JMBG), birth_date, gender
 *   * address, city, postal_code
 *   * bank_name, bank_account
 *   * phone_work (alias za legacy `phone`), phone_private
 *   * emergency_contact_name, emergency_contact_phone
 *   * slava, slava_day, education_level, education_title
 *   * medical_exam_date, medical_exam_expires, team
 *
 * SELECT se radi preko `v_employees_safe` view-a koji maskira osetljiva polja
 * za sve koji nisu admin (migracija `restrict_employee_pii_admin_only.sql`).
 * INSERT/UPDATE/DELETE idu direktno na `employees` tabelu, uz trigger
 * `employees_sensitive_guard` koji odbija izmenu osetljivih kolona ako korisnik nije admin.
 */

import { sbReq } from './supabase.js';
import { canEditKadrovska, getIsOnline } from '../state/auth.js';
import { employeeDisplayName } from '../lib/employeeNames.js';

/** Maskirati JMBG/bank/address za ne-HR user-e (ovde radimo samo defensive passthrough). */
export function mapDbEmployee(d) {
  const firstName = d.first_name || '';
  const lastName = d.last_name || '';
  const fullName = employeeDisplayName({
    fullName: d.full_name,
    firstName,
    lastName,
  });
  return {
    id: d.id,
    fullName,
    firstName,
    lastName,
    position: d.position || '',
    department: d.department || '',
    team: d.team || '',
    phone: d.phone || d.phone_work || '',
    phoneWork: d.phone_work || d.phone || '',
    phonePrivate: d.phone_private || '',
    email: d.email || '',
    hireDate: d.hire_date || '',
    isActive: d.is_active !== false,
    note: d.note || '',
    personalId: d.personal_id || '',
    birthDate: d.birth_date || '',
    gender: d.gender || '',
    address: d.address || '',
    city: d.city || '',
    postalCode: d.postal_code || '',
    bankName: d.bank_name || '',
    bankAccount: d.bank_account || '',
    emergencyContactName: d.emergency_contact_name || '',
    emergencyContactPhone: d.emergency_contact_phone || '',
    slava: d.slava || '',
    slavaDay: d.slava_day || '',
    educationLevel: d.education_level || '',
    educationTitle: d.education_title || '',
    medicalExamDate: d.medical_exam_date || '',
    medicalExamExpires: d.medical_exam_expires || '',
    createdAt: d.created_at || null,
    updatedAt: d.updated_at || null,
  };
}

export function buildEmployeePayload(emp) {
  /* full_name je zadržan kao legacy kolona radi kompatibilnosti — gradimo ga
     iz first_name/last_name ako ih imamo, inače iz fullName. */
  const first = (emp.firstName || '').trim();
  const last  = (emp.lastName || '').trim();
  const fullName = (first || last)
    ? [last, first].filter(Boolean).join(' ')
    : (emp.fullName || '').trim();

  const p = {
    full_name: fullName,
    first_name: first || null,
    last_name: last || null,
    position: emp.position || '',
    department: emp.department || '',
    team: emp.team || null,
    phone: emp.phoneWork || emp.phone || '',
    email: emp.email || '',
    hire_date: emp.hireDate || null,
    is_active: emp.isActive !== false,
    note: emp.note || '',
    birth_date: emp.birthDate || null,
    gender: emp.gender || null,
    slava: emp.slava || null,
    slava_day: emp.slavaDay || null,
    education_level: emp.educationLevel || null,
    education_title: emp.educationTitle || null,
    medical_exam_date: emp.medicalExamDate || null,
    medical_exam_expires: emp.medicalExamExpires || null,
    updated_at: new Date().toISOString(),
  };

  /* Osetljiva polja — uključujemo ih u payload SAMO ako su prisutna u emp objektu
     (izbegava accidental NULL-ovanje kada ne-HR user edituje osnovne podatke).
     Ako hoćeš eksplicitno da obrišeš neko polje, pošalji prazan string ''. */
  if ('personalId' in emp)            p.personal_id = emp.personalId || null;
  if ('address' in emp)               p.address = emp.address || null;
  if ('city' in emp)                  p.city = emp.city || null;
  if ('postalCode' in emp)            p.postal_code = emp.postalCode || null;
  if ('bankName' in emp)              p.bank_name = emp.bankName || null;
  if ('bankAccount' in emp)           p.bank_account = emp.bankAccount || null;
  if ('phonePrivate' in emp)          p.phone_private = emp.phonePrivate || null;
  if ('emergencyContactName' in emp)  p.emergency_contact_name = emp.emergencyContactName || null;
  if ('emergencyContactPhone' in emp) p.emergency_contact_phone = emp.emergencyContactPhone || null;

  if (emp.id) p.id = emp.id;
  return p;
}

/**
 * Čitanje svih zaposlenih preko maskirajućeg view-a.
 * Napomena: `hire_date` u view-u dolazi iz employees.hire_date.
 */
export async function loadEmployeesFromDb() {
  if (!getIsOnline()) return null;
  /* Prvo pokušaj preko proširenog view-a (Faza K2). */
  let data = await sbReq('v_employees_safe?select=*&order=last_name.asc,first_name.asc');
  if (data) return data.map(mapDbEmployee);

  /* Fallback: ako view nije postavljen (migracija nije primenjena), čitaj direktno. */
  data = await sbReq('employees?select=*&order=last_name.asc,first_name.asc,full_name.asc');
  if (!data) return null;
  return data.map(mapDbEmployee);
}

export async function saveEmployeeToDb(emp) {
  if (!getIsOnline() || !canEditKadrovska()) return null;
  const res = await sbReq('employees', 'POST', buildEmployeePayload(emp));
  if (res === null) {
    console.warn('[kadrovska] Save failed. Is migracija add_kadr_employee_extended.sql primenjena?');
  }
  return res;
}

export async function updateEmployeeInDb(emp) {
  if (!getIsOnline() || !canEditKadrovska() || !emp.id) return null;
  const { id, ...rest } = buildEmployeePayload(emp);
  return await sbReq(
    `employees?id=eq.${encodeURIComponent(emp.id)}`,
    'PATCH',
    rest,
  );
}

export async function deleteEmployeeFromDb(id) {
  if (!getIsOnline() || !canEditKadrovska() || !id) return false;
  const res = await sbReq(`employees?id=eq.${encodeURIComponent(id)}`, 'DELETE');
  return res !== null;
}
