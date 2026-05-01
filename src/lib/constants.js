/**
 * Centralna lista svih konstanti, localStorage/sessionStorage ključeva i
 * default vrednosti. ⚠ NE MENJAJ NIJEDAN ključ — postojeći korisnici imaju
 * podatke pod ovim ključevima. Migracija mora da bude bit-paritetna sa
 * legacy/index.html.
 */

/** Ime proizvoda (SaaS / MES brend) — naslovi, login, hub. */
export const APP_PRODUCT_NAME = 'Servosync';

/** Pun naslov u browser tabu / `<title>` (verzija za korisnike). */
export const APP_DOCUMENT_TITLE = 'Servosync V1.0';

/* ── localStorage ključevi ── */
export const STORAGE_KEYS = Object.freeze({
  /* Plan Montaže */
  LEAD: 'plan_montaze_leads_v1',
  ENG: 'plan_montaze_engineers_v1',
  LOCAL: 'plan_montaze_v5_cache',
  AUTH: 'plan_montaze_v51_auth',
  LOC_COLOR: 'plan_montaze_loc_colors_v1',
  PHASE_MODEL: 'plan_montaze_phase_models_v1',
  GANTT_SHOW_DONE: 'plan_montaze_gantt_show_done_v1',
  /* Kadrovska — cache + ostalo */
  /* v2: invalidacija 2026-04 — stari keš imao pogođen department nakon promene u bazi. */
  KADROVSKA: 'plan_montaze_kadrovska_v2',
  KADR_ABS: 'plan_montaze_kadr_absences_v1',
  KADR_WH: 'plan_montaze_kadr_work_hours_v1',
  KADR_CON: 'plan_montaze_kadr_contracts_v1',
  /* Lokacije delova */
  LOC_TAB: 'plan_montaze_loc_active_tab_v1',
  LOC_PREDMET: 'plan_montaze_loc_predmet_state_v1',
  LOC_SORT: 'plan_montaze_loc_sort_v1',
  /* Podešavanja */
  USERS_CACHE: 'plan_montaze_users_v1',
  /* Theme */
  THEME: 'pm_theme_v1',
});

/* ── Role labele za UI ── */
export const ROLE_LABELS = Object.freeze({
  admin: 'Admin',
  leadpm: 'Lead PM',
  pm: 'PM',
  menadzment: 'Menadžment',
  hr: 'HR',
  viewer: 'Viewer',
});

/* ── sessionStorage ključevi ── */
export const SESSION_KEYS = Object.freeze({
  KADR_TAB: 'plan_montaze_kadr_active_tab_v1',
  /** Pretraga u Mesečnom gridu (Kadrovska) — vidljivost redova, ne lokalni storage */
  KADR_GRID_SEARCH: 'plan_montaze_kadr_grid_search_v1',
  MODULE_HUB: 'plan_montaze_v51_active_module',
  SETTINGS_TAB: 'plan_montaze_v51_settings_tab',
  /** Posle login-a: pun path + query (npr. /maintenance/machines/8.3?tab=checks) */
  POST_LOGIN_REDIRECT: 'plan_montaze_v51_post_login_redirect_v1',
  /** Sastanci: lista / kalendar u tabu Sastanci */
  SAST_SASTANCI_VIEW: 'sastanci:sastanci_view',
  /** Jednokratni otvor Akcioni plan sa "moje" filterom (string '1' pa briši) */
  SAST_INTENT_AKCIJONI_MOJE: 'sastanci:intent_akcioni_moje',
  /** Jednokratni fokus PM teme sub-tab = moje (string '1' pa briši) */
  SAST_INTENT_PM_MOJE: 'sastanci:intent_pm_moje',
  /** Aktivni interni tab u detalju sastanka ('pripremi'|'zapisnik'|'akcije'|'arhiva') */
  SAST_DETALJ_TAB: 'sastanci:detalj_tab',
  /** Lista / Kanban u Akcionom planu ('lista'|'kanban') */
  SAST_AKCIONI_VIEW: 'sastanci:akcioni_view',
});

/* ── Role hijerarhija (priority: admin > leadpm > pm > menadzment > hr > viewer) ── */
export const ROLES = Object.freeze(['admin', 'leadpm', 'pm', 'menadzment', 'hr', 'viewer']);

/* ── Plan Montaže defaults ── */
export const DEFAULT_PHASES = Object.freeze([
  'Montaža agregata',
  'Elektro montaža agregata',
  'Montaža postolja prese sa cilindrima',
  'Montaža agregata na lokaciji naručioca',
  'Povezivanje agregata sa cilindrima',
  'Montaža na batu',
  'Elektro montaža bata',
  'Kompletiranje tela prese',
  'Montaža ruke podmazivanja',
  'Elektro montaža ruke podmazivanja',
  'Montaža ruke podmazivanja (2)',
  'Postavljanje robota',
  'Postavljanje agregata podmazivanja',
  'Postavljanje kanalica',
  'Elektro povezivanje kompletne prese',
]);

export const STATUSES = Object.freeze(['Nije počelo', 'U toku', 'Završeno', 'Na čekanju']);

export const VODJA_DEFAULT = Object.freeze([
  '',
  'Miloš Oreščanin',
  'Vladan Radivojević',
  'Stefan Mirić',
  'Slaviša Babić',
  'Goran Mlađenović',
]);

export const ENGINEERS_DEFAULT = Object.freeze([
  '',
  'Dejan Ćirković',
  'Đorđe Arsić',
  'Igor Voštić',
  'Jovan Papić',
  'Luka Talović',
  'Marko Stojanović',
  'Milan Milovanović',
  'Milan Stojadinović',
  'Milorad Jerotić',
  'Nebojša Milošević',
  'Nikola Aksentijević',
  'Pavle Ilić',
  'Slaviša Radosavljević',
  'Tatjana Gnjidić',
  'Vladan Pavlović',
  'Vuk Radivojević',
]);

export const CHECK_LABELS = Object.freeze([
  'Montažni crteži',
  'Mašinske komponente',
  'Gotova roba',
  'Vijčana roba',
  'Električni materijal',
  'Alati / oprema',
  'Termin potvrđen',
  'Dostupna ekipa',
]);

export const CHECK_SHORT = Object.freeze([
  'Crteži', 'Mašin.', 'Got.rob', 'Vijci', 'Elektro', 'Alati', 'Termin', 'Ekipa',
]);

export const NUM_CHECKS = CHECK_LABELS.length;

export const MONTHS_SR = Object.freeze([
  'Januar', 'Februar', 'Mart', 'April', 'Maj', 'Jun',
  'Jul', 'Avgust', 'Septembar', 'Oktobar', 'Novembar', 'Decembar',
]);

export const DEFAULT_LOCATIONS = Object.freeze(['Dobanovci', 'Kruševac']);

export const LOC_PALETTE = Object.freeze([
  '#4da3ff', '#7ee787', '#ffa657', '#d2a8ff', '#f778ba', '#79c0ff',
  '#f0b429', '#56d4dd', '#ff8b5d', '#a5d6a7', '#ce93d8', '#ffcb6b',
  '#90caf9', '#ef9a9a', '#80cbc4', '#b39ddb', '#ffab91', '#c5e1a5',
]);

export const SAVE_DEBOUNCE_MS = 700;

/* ── Kadrovska — labele i tipovi ── */
export const KADR_ABS_TYPE_LABELS = Object.freeze({
  godisnji: 'Godišnji odmor',
  bolovanje: 'Bolovanje',
  /* Kanonska vrednost je 'sluzbeno' (poklapa se sa DB CHECK constraint). */
  sluzbeno: 'Službeni put',
  /* Legacy kod koji je pisao 'sluzbeni' — fallback labela, isti prikaz. */
  sluzbeni: 'Službeni put',
  slobodan: 'Slobodan dan',
  neplaceno: 'Neplaćeno odsustvo',
  placeno: 'Plaćeno odsustvo',
  slava: 'Krsna slava',
  ostalo: 'Ostalo',
});

/** Razlog za plaćeno odsustvo (tip 'placeno'). */
export const KADR_PAID_REASON_LABELS = Object.freeze({
  rodjenje: 'Rođenje deteta',
  svadba: 'Svadba',
  smrt: 'Smrtni slučaj',
  selidba: 'Selidba',
  ostalo: 'Ostalo',
});

/** Stepen stručne spreme — srpska klasifikacija. */
export const KADR_EDU_LEVEL_LABELS = Object.freeze({
  I: 'I stepen',
  II: 'II stepen',
  III: 'III stepen',
  IV: 'IV stepen (SSS)',
  V: 'V stepen (VKV)',
  VI: 'VI stepen (VŠ)',
  VII: 'VII stepen (VSS)',
  VIII: 'VIII stepen (Magistar)',
  IX: 'IX stepen (Doktor nauka)',
});

export const KADR_CON_TYPE_LABELS = Object.freeze({
  neodredjeno: 'Neodređeno',
  odredjeno: 'Određeno',
  privremeno: 'Privremeni / povremeni',
  delo: 'Ugovor o delu',
  praksa: 'Stručna praksa',
});

/* ── Supabase config (iz Vite env vars) ──
 *
 * DEFENZIVNO čišćenje vrednosti — Cloudflare Pages UI ponekad ostavi
 * trailing whitespace ili newline kad korisnik paste-uje URL/anon key.
 * Bez `.trim()` browser pokuša da reši `xyz.supabase.co%20` (razmak je
 * URL-encoded kao %20) → ERR_NAME_NOT_RESOLVED. Skidamo i trailing `/`
 * jer `sbReq()` već dodaje vodeći `/` na rest path-u.
 */
function _cleanEnvUrl(v) {
  return String(v || '').trim().replace(/\/+$/, '');
}
function _cleanEnvKey(v) {
  return String(v || '').trim();
}

export const SUPABASE_CONFIG = Object.freeze({
  url: _cleanEnvUrl(import.meta.env.VITE_SUPABASE_URL),
  anonKey: _cleanEnvKey(import.meta.env.VITE_SUPABASE_ANON_KEY),
  reminderEndpoint: '/functions/v1/send-reminders',
});

export function hasSupabaseConfig() {
  return !!(SUPABASE_CONFIG.url && SUPABASE_CONFIG.anonKey);
}

/**
 * "Nastavi offline" dugme na login ekranu.
 *
 * Bezbednost (Faza 1, 2026-04-23): offline mode UI prevara — postavlja
 * `pm` rolu bez prave autentifikacije. Server-side RLS i dalje blokira
 * pisanja (token je null → fallback na anon ključ → `TO authenticated`
 * politike pucaju), ali korisnik vidi cache-irane podatke i UI mu
 * dozvoljava pokušaje izmena koji tiho propadaju.
 *
 * Default: ISKLJUČENO. Uključuje se eksplicitnim VITE_ENABLE_OFFLINE_MODE=true
 * u `.env` za lokalni dev / ad-hoc terensko testiranje. Production build
 * (Cloudflare Pages) NEMA ovaj flag → dugme se ne renderuje.
 */
export function isOfflineModeEnabled() {
  const v = String(import.meta.env.VITE_ENABLE_OFFLINE_MODE || '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}
