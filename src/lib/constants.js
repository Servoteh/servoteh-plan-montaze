/**
 * Centralna lista svih konstanti, localStorage/sessionStorage ključeva i
 * default vrednosti. ⚠ NE MENJAJ NIJEDAN ključ — postojeći korisnici imaju
 * podatke pod ovim ključevima. Migracija mora da bude bit-paritetna sa
 * legacy/index.html.
 */

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
  KADROVSKA: 'plan_montaze_kadrovska_v1',
  KADR_ABS: 'plan_montaze_kadr_absences_v1',
  KADR_WH: 'plan_montaze_kadr_work_hours_v1',
  KADR_CON: 'plan_montaze_kadr_contracts_v1',
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
  hr: 'HR',
  viewer: 'Viewer',
});

/* ── sessionStorage ključevi ── */
export const SESSION_KEYS = Object.freeze({
  KADR_TAB: 'plan_montaze_kadr_active_tab_v1',
  MODULE_HUB: 'plan_montaze_v51_active_module',
  SETTINGS_TAB: 'plan_montaze_v51_settings_tab',
});

/* ── Role hijerarhija (priority: admin > leadpm > pm > hr > viewer) ── */
export const ROLES = Object.freeze(['admin', 'leadpm', 'pm', 'hr', 'viewer']);

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
  sluzbeni: 'Službeni put',
  neplaceno: 'Neplaćeno odsustvo',
  placeno: 'Plaćeno odsustvo',
  ostalo: 'Ostalo',
});

export const KADR_CON_TYPE_LABELS = Object.freeze({
  neodredjeno: 'Neodređeno',
  odredjeno: 'Određeno',
  privremeno: 'Privremeni / povremeni',
  delo: 'Ugovor o delu',
  praksa: 'Stručna praksa',
});

/* ── Supabase config (iz Vite env vars) ── */
export const SUPABASE_CONFIG = Object.freeze({
  url: import.meta.env.VITE_SUPABASE_URL || '',
  anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY || '',
  reminderEndpoint: '/functions/v1/send-reminders',
});

export function hasSupabaseConfig() {
  return !!(SUPABASE_CONFIG.url && SUPABASE_CONFIG.anonKey);
}
