/**
 * Globalno stanje Kadrovska modula.
 *
 * Sva 4 sub-state objekta (employees, absences, work_hours, contracts) imaju
 * isti shape: { items / employees, loaded, _schema }.
 *  - loaded → da li je load() pokrenut barem jednom
 *  - _schema → da li sql migracija postoji u DB-u (false ako save padne)
 *
 * Cache se čuva u localStorage pod ključevima iz STORAGE_KEYS, tako da
 * korisnik vidi nešto i ako Supabase pukne između session-a.
 *
 * UI sloj (Faza 4) treba da zove `ensure*Loaded()` pre rendera.
 */

import { lsGetJSON, lsSetJSON, ssGet, ssSet } from '../lib/storage.js';
import { STORAGE_KEYS, SESSION_KEYS } from '../lib/constants.js';

/* ── Sub-states ── */
export const kadrovskaState = {
  employees: [],
  loaded: false,
  _schemaSupported: true,
  /** Trenutno aktivan tab (sync sa session storage; default 'grid' — Mesečni grid). */
  activeTab: ssGet(SESSION_KEYS.KADR_TAB, 'grid'),
};

export const kadrAbsencesState = {
  items: [],
  loaded: false,
  _schema: true,
};

export const kadrWorkHoursState = {
  items: [],
  loaded: false,
  _schema: true,
};

export const kadrContractsState = {
  items: [],
  loaded: false,
  _schema: true,
};

/* Faza K2 — godišnji odmor (entitlements + saldo) */
export const kadrVacationState = {
  /** lista entitlement redova (po zaposlenom × po godini) */
  entitlements: [],
  /** saldo iz view-a: { employeeId, year, daysTotal, daysCarriedOver, daysUsed, daysRemaining } */
  balances: [],
  loadedYear: null,
  loaded: false,
  _schema: true,
};

/* Faza K2 — deca zaposlenih (samo admin vidi, RLS) */
export const kadrChildrenState = {
  /** Map<employeeId, Array<{id, firstName, birthDate, ...}>> — lazy po zaposlenom */
  byEmp: new Map(),
};

/* Org struktura — odeljenja / pododeljenja / radna mesta */
export const orgStructureState = {
  departments:    [],  /* { id, name, sort_order } */
  subDepartments: [],  /* { id, department_id, name, sort_order } */
  jobPositions:   [],  /* { id, department_id, sub_department_id, name, sort_order } */
  loaded: false,
};

/* Faza K3 — zarade (samo admin vidi) */
export const kadrSalaryState = {
  /** Aktuelne zarade (iz v_employee_current_salary) po employeeId */
  current: [],
  /** Map<employeeId, Array<termRow>> — istorija zarada (lazy) */
  termsByEmp: new Map(),
  loaded: false,
  _schema: true,
};

/* Faza K3.2 — mesečni obračun plata (samo admin) */
export const kadrPayrollState = {
  /** Izabrani mesec (ISO „YYYY-MM"); default = tekući */
  selectedYear: new Date().getFullYear(),
  selectedMonth: new Date().getMonth() + 1,
  /** Key „YYYY-MM" → Array<payrollRow> */
  byPeriod: new Map(),
};

/* Državni praznici / neradni dani za mesečni grid i obračun. */
export const kadrHolidaysState = {
  /** Map<'YYYY-MM-DD', holidayRow> */
  byDate: new Map(),
  /** Set<year> koji su već učitani iz kadr_holidays. */
  loadedYears: new Set(),
};

/* ── Aktivni tab (sessionStorage, traje koliko i tab browsera) ── */
export function getActiveKadrTab() {
  return ssGet(SESSION_KEYS.KADR_TAB, 'grid');
}

export function setActiveKadrTab(tab) {
  ssSet(SESSION_KEYS.KADR_TAB, tab);
}

/* ── Cache helperi ── */
export function loadEmployeesCache() {
  return lsGetJSON(STORAGE_KEYS.KADROVSKA, []) || [];
}
export function saveEmployeesCache(list) {
  lsSetJSON(STORAGE_KEYS.KADROVSKA, list || []);
}

export function loadAbsencesCache() {
  return lsGetJSON(STORAGE_KEYS.KADR_ABS, []) || [];
}
export function saveAbsencesCache(list) {
  lsSetJSON(STORAGE_KEYS.KADR_ABS, list || []);
}

export function loadWorkHoursCache() {
  return lsGetJSON(STORAGE_KEYS.KADR_WH, []) || [];
}
export function saveWorkHoursCache(list) {
  lsSetJSON(STORAGE_KEYS.KADR_WH, list || []);
}

export function loadContractsCache() {
  return lsGetJSON(STORAGE_KEYS.KADR_CON, []) || [];
}
export function saveContractsCache(list) {
  lsSetJSON(STORAGE_KEYS.KADR_CON, list || []);
}

/* ── Resetovanje na logout (security: ne curiti podatke između naloga) ── */
export function resetKadrovskaState() {
  kadrovskaState.employees = [];
  kadrovskaState.loaded = false;
  kadrAbsencesState.items = [];
  kadrAbsencesState.loaded = false;
  kadrWorkHoursState.items = [];
  kadrWorkHoursState.loaded = false;
  kadrContractsState.items = [];
  kadrContractsState.loaded = false;
  kadrVacationState.entitlements = [];
  kadrVacationState.balances = [];
  kadrVacationState.loadedYear = null;
  kadrVacationState.loaded = false;
  kadrChildrenState.byEmp.clear();
  kadrSalaryState.current = [];
  kadrSalaryState.termsByEmp.clear();
  kadrSalaryState.loaded = false;
  kadrPayrollState.byPeriod.clear();
  kadrPayrollState.selectedYear = new Date().getFullYear();
  kadrPayrollState.selectedMonth = new Date().getMonth() + 1;
  kadrHolidaysState.byDate.clear();
  kadrHolidaysState.loadedYears.clear();
}
