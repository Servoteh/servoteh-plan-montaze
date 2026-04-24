/**
 * Globalno stanje autentifikacije.
 *
 * Razlog za postojanje ovog modula umesto golih `let` u `services/supabase.js`:
 *   - sbReq() i pozivi servisa moraju da znaju trenutni JWT token.
 *   - Auth servis menja korisnika nakon login-a.
 *   - UI sloj treba da reaguje na promenu (npr. da ažurira hub i header).
 *
 * Modul izlaže snapshot getter (`getAuth`) i mali pub/sub (`onAuthChange`).
 * Nikad ne čuvamo password u memoriji — samo email + Supabase session token.
 */

import { lsGetJSON, lsSetJSON, lsRemove } from '../lib/storage.js';
import { STORAGE_KEYS } from '../lib/constants.js';

/* Interni state — nikad ne eksportuj direktno. */
const state = {
  /** { email, emailRaw, id, _token, _refreshToken, _expiresAt } | null */
  user: null,
  /** 'admin' | 'leadpm' | 'pm' | 'menadzment' | 'hr' | 'viewer' */
  role: 'viewer',
  /** Postoji li trenutno mreža + Supabase odgovara? Postavlja services/supabase.js. */
  isOnline: false,
  /** True ako je poslednji /user_roles upit pao zbog HTTP/parse greške. */
  lastUserRolesQueryFailed: false,
};

const listeners = new Set();

function notify() {
  for (const fn of listeners) {
    try {
      fn(getAuth());
    } catch (e) {
      console.error('[auth] listener error', e);
    }
  }
}

/* ── Public API ── */

/** Vrati read-only snapshot — UI sloj NIKAD ne sme da mutira ovaj objekat. */
export function getAuth() {
  return {
    user: state.user,
    role: state.role,
    isOnline: state.isOnline,
    lastUserRolesQueryFailed: state.lastUserRolesQueryFailed,
  };
}

export function getCurrentUser() {
  return state.user;
}

export function getCurrentRole() {
  return state.role;
}

export function getIsOnline() {
  return state.isOnline;
}

export function setUser(user) {
  state.user = user;
  notify();
}

export function setRole(role) {
  state.role = role || 'viewer';
  notify();
}

export function setOnline(flag) {
  state.isOnline = !!flag;
  notify();
}

export function setLastUserRolesQueryFailed(flag) {
  state.lastUserRolesQueryFailed = !!flag;
}

/** Subscribe na bilo koju promenu. Vrati `unsubscribe()` funkciju. */
export function onAuthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/* ── Role helperi (bit-paritet sa legacy/index.html) ── */

export function canEdit() {
  /* Menadžment ima edit pristup Plan Montaže modulu (planiranje + montaže) —
     sinhronizovano sa DB has_edit_role() koji u pilot fazi vraća TRUE za
     sve authenticated. */
  return ['admin', 'leadpm', 'pm', 'menadzment'].includes(state.role);
}
export function isMagacioner() {
  return state.role === 'magacioner';
}
export function isCncOperater() {
  return state.role === 'cnc_operater';
}
export function isLeadPM() {
  return state.role === 'leadpm';
}
export function isAdmin() {
  return state.role === 'admin';
}
export function isHR() {
  return state.role === 'hr' || isAdmin();
}
/**
 * ERP admin ili menadzment — širi krug ovlašćenja koji sme da radi
 * destruktivne operacije nad katalogom (npr. trajno brisanje mašine
 * u modulu Održavanje). Sinhronizovano sa Postgres helperom
 * `maint_is_erp_admin_or_management()`.
 */
export function isAdminOrMenadzment() {
  return state.role === 'admin' || state.role === 'menadzment';
}

/**
 * Modul Podešavanja: ERP admin ima sve tabove; menadžment vidi samo „Održ. profili”
 * (upravljanje `maint_user_profiles` u skladu sa RLS).
 */
export function canAccessPodesavanja() {
  return isAdminOrMenadzment();
}

/**
 * Sinhronizovano sa `maint_has_floor_read_access()` u bazi — pregled cele fabrike
 * bez obaveznog reda u `maint_user_profiles`. Koristi se da se ne prikaže
 * pogrešno upozorenje „profil nije podešen” korisnicima koji već imaju širok pristup.
 */
export function maintHasFloorReadAccess() {
  return ['admin', 'pm', 'leadpm', 'menadzment'].includes(state.role);
}
/**
 * Da li trenutni korisnik može da vidi i uređuje osetljiva polja zaposlenog
 * (JMBG, adresa, broj računa, privatni telefon, kontakt osobe, deca)?
 * Sinhronizovano sa Postgres helperom `current_user_is_hr_or_admin()`
 * (admin / hr / menadzment).
 */
export function isHrOrAdmin() {
  return ['admin', 'hr', 'menadzment'].includes(state.role);
}
export function canManageUsers() {
  return isAdmin();
}
/**
 * Ko može da uđe u Kadrovska modul?
 *  - admin / hr / menadzment: pun pristup svim tabovima (uz dalje provere
 *    canEditKadrovska / canAccessSalary / canEditKadrovskaGrid).
 *  - Ostali: nemaju pristup modulu.
 */
export function canAccessKadrovska() {
  return isHR() || isAdmin() || state.role === 'menadzment';
}
/**
 * Kadrovska modul — CRUD nad zaposlenima / odsustvima / godišnjim / ugovorima.
 * Po dogovoru „svako kao HR": admin / hr / menadzment / pm / leadpm imaju
 * edit. Menadzment od ove iteracije ima pun edit nad svim sekcijama Kadrovske
 * (osim Zarada — vidi `canAccessSalary`). Sinhronizovano sa Postgres
 * funkcijom `has_edit_role()` (migracija add_menadzment_full_edit_kadrovska).
 */
export function canEditKadrovska() {
  return ['admin', 'leadpm', 'pm', 'hr', 'menadzment'].includes(state.role);
}
/**
 * Mesečni grid (unos sati / odsustva na nivou dana): zajedno sa HR-om i
 * menadzment-om — sve role koje realno pune tabelu za obračun. Admin/PM/
 * LeadPM su ovde iz istih razloga kao i u `canEdit`.
 *
 * Napomena: RLS na `work_hours` trenutno dozvoljava svim authenticated
 * (pilot), ali UI dodatno štiti od slučajnih izmena.
 */
export function canEditKadrovskaGrid() {
  return ['admin', 'leadpm', 'pm', 'hr', 'menadzment'].includes(state.role);
}
/**
 * Zarade (Faza K3): STRIKTNO samo admin može da vidi i menja.
 * HR (Mrkajić) namerno NEMA pristup — zarade drži uprava.
 * Sinhronizovano sa RLS politikama na `salary_terms` u bazi.
 */
export function canAccessSalary() {
  return state.role === 'admin';
}
/**
 * Plan Proizvodnje: modul vide svi ulogovani; pun edit za admin / pm / menadzment
 * (`canEditPlanProizvodnje`). Read-only: leadpm, hr, viewer.
 */
export function canAccessPlanProizvodnje() {
  /* Svi koji su ulogovani vide modul (read-only za viewer/leadpm/hr/cnc_operater). */
  return ['admin', 'leadpm', 'pm', 'menadzment', 'hr', 'viewer', 'cnc_operater'].includes(state.role);
}
export function canEditPlanProizvodnje() {
  /* Menadžment sme da menja operacije / crteže — mora biti sinhronizovano
     sa DB funkcijom public.can_edit_plan_proizvodnje() (vidi migraciju
     add_plan_proizvodnje_menadzment_edit.sql). */
  return ['admin', 'pm', 'menadzment'].includes(state.role);
}

/**
 * Modul Sastanci — svi authenticated mogu da otvore i čitaju.
 * Pisanje (kreiranje sastanaka, dodavanje tema, akcionog plana) je za
 * admin/pm/leadpm/menadzment — viewer i hr su read-only.
 */
export function canAccessSastanci() {
  return ['admin', 'leadpm', 'pm', 'menadzment', 'hr', 'viewer'].includes(state.role);
}

/**
 * Odeljenja nad kojima trenutni korisnik ima scope (odobravanje odmora itd.).
 * NULL / undefined = neograničen pristup (admin, COO, HR).
 * Popunjen niz = filtrira samo ta odeljenja.
 * Popunjava se iz user_roles.managed_departments prilikom login-a.
 */
export function getManagedDepartments() {
  return state.managedDepartments ?? null;
}
export function setManagedDepartments(depts) {
  state.managedDepartments = Array.isArray(depts) ? depts : null;
}
export function canEditSastanci() {
  return ['admin', 'leadpm', 'pm', 'menadzment'].includes(state.role);
}

/**
 * Samo admin može da menja master prioritet (admin_rang) i da označi temu
 * kao "za razmatranje" na sledećem sastanku Menadžmenta.
 */
export function canPrioritizeTeme() {
  return state.role === 'admin';
}

/**
 * Modul Lokacije delova — svi ulogovani korisnici mogu da otvore (čitanje + pokreti
 * preko RPC; master lokacije: admin/leadpm/pm u RLS-u).
 */
export function canAccessLokacije() {
  /* Svi ulogovani korisnici uključujući magacioner i cnc_operater. */
  return !!state.user;
}

/** Sync monitor (loc_sync_outbound_events) — samo admin po RLS-u. */
export function canViewLokacijeSync() {
  return state.role === 'admin';
}

/**
 * Da li trenutni korisnik vlasnik teme (predlozio_email).
 * Koristi se za "edit only own" gate na PM temama.
 */
export function isTemaOwner(predlozioEmail) {
  if (!predlozioEmail || !state.user?.email) return false;
  return String(predlozioEmail).toLowerCase() === String(state.user.email).toLowerCase();
}

/* ── Persistencija sesije u localStorage (fallback ako Supabase ne stigne) ── */

export function loadPersistedSession() {
  return lsGetJSON(STORAGE_KEYS.AUTH, null);
}

export function persistSession(session) {
  if (session) {
    lsSetJSON(STORAGE_KEYS.AUTH, session);
  } else {
    lsRemove(STORAGE_KEYS.AUTH);
  }
}
