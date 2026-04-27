/**
 * URL rute aplikacije (History API). Cloudflare Pages već šalje sve nepoznate
 * putanje na /index.html (public/_redirects).
 *
 * Mašina u deep linku: segment path-a je `encodeURIComponent(rj_code)` npr. 8.3.
 */

/** @param {string} pathname */
function normalizePathname(pathname) {
  const raw = pathname && pathname !== '' ? pathname : '/';
  if (raw.length > 1 && raw.endsWith('/')) return raw.slice(0, -1);
  return raw;
}

/**
 * @param {string} pathname
 * @returns {{
 *   kind: 'session'
 *   | 'hub'
 *   | 'module'
 *   | 'maintenance'
 *   | 'mobile'
 *   | 'reset-password'
 *   | 'unknown',
 *   moduleId?: string,
 *   section?: 'dashboard' | 'machines' | 'machine' | 'board' | 'notifications' | 'catalog' | 'locations' | 'workorders',
 *   machineCode?: string,
 *   mobileScreen?: 'home' | 'scan' | 'manual' | 'history' | 'batch' | 'lookup'
 * }}
 */
export function pathnameToRoute(pathname) {
  const p = normalizePathname(pathname);
  if (p === '/') {
    return { kind: 'session' };
  }
  if (p === '/hub') {
    return { kind: 'hub' };
  }
  /* Reset password — javna stranica (bez login guard-a). Supabase u mail-u
   * šalje redirect_to sa `/reset-password#access_token=...&type=recovery`
   * (implicit flow) ili `?code=...` (PKCE flow). */
  if (p === '/reset-password') {
    return { kind: 'reset-password' };
  }
  /* Mobilni shell za magacionere / viljuškariste (Faza 1 — PWA + Capacitor wrapper).
   * Namerno plitak tree: `/m` (home), i pod-rute (scan, manual, history, batch, lookup).
   * Sve nepoznate `/m/*` vode na home. */
  if (p === '/m') {
    return { kind: 'mobile', mobileScreen: 'home' };
  }
  if (p === '/m/scan') {
    return { kind: 'mobile', mobileScreen: 'scan' };
  }
  if (p === '/m/manual') {
    return { kind: 'mobile', mobileScreen: 'manual' };
  }
  if (p === '/m/history') {
    return { kind: 'mobile', mobileScreen: 'history' };
  }
  if (p === '/m/batch') {
    return { kind: 'mobile', mobileScreen: 'batch' };
  }
  if (p === '/m/lookup') {
    return { kind: 'mobile', mobileScreen: 'lookup' };
  }
  if (p === '/plan-montaze') {
    return { kind: 'module', moduleId: 'plan-montaze' };
  }
  if (p === '/lokacije-delova') {
    return { kind: 'module', moduleId: 'lokacije-delova' };
  }
  if (p === '/plan-proizvodnje') {
    return { kind: 'module', moduleId: 'plan-proizvodnje' };
  }
  if (p === '/pracenje-proizvodnje') {
    return { kind: 'module', moduleId: 'pracenje-proizvodnje' };
  }
  if (p === '/kadrovska') {
    return { kind: 'module', moduleId: 'kadrovska' };
  }
  if (p === '/sastanci') {
    return { kind: 'module', moduleId: 'sastanci' };
  }
  if (p === '/sastanci/podesavanja-notifikacija') {
    return { kind: 'module', moduleId: 'sastanci', sastanciTab: 'podesavanja-notif' };
  }
  const sd = /^\/sastanci\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(p);
  if (sd) {
    return { kind: 'module', moduleId: 'sastanci', sastanakId: sd[1] };
  }
  if (p === '/podesavanja') {
    return { kind: 'module', moduleId: 'podesavanja' };
  }
  if (p === '/maintenance') {
    return { kind: 'maintenance', moduleId: 'odrzavanje-masina', section: 'dashboard' };
  }
  if (p === '/maintenance/machines') {
    return { kind: 'maintenance', moduleId: 'odrzavanje-masina', section: 'machines' };
  }
  if (p === '/maintenance/board') {
    return { kind: 'maintenance', moduleId: 'odrzavanje-masina', section: 'board' };
  }
  if (p === '/maintenance/notifications') {
    return { kind: 'maintenance', moduleId: 'odrzavanje-masina', section: 'notifications' };
  }
  if (p === '/maintenance/catalog') {
    return { kind: 'maintenance', moduleId: 'odrzavanje-masina', section: 'catalog' };
  }
  if (p === '/maintenance/locations') {
    return { kind: 'maintenance', moduleId: 'odrzavanje-masina', section: 'locations' };
  }
  if (p === '/maintenance/work-orders') {
    return { kind: 'maintenance', moduleId: 'odrzavanje-masina', section: 'workorders' };
  }
  const mm = /^\/maintenance\/machines\/([^/]+)$/.exec(p);
  if (mm) {
    let machineCode = mm[1];
    try {
      machineCode = decodeURIComponent(machineCode);
    } catch {
      /* ostavi raw segment */
    }
    return {
      kind: 'maintenance',
      moduleId: 'odrzavanje-masina',
      section: 'machine',
      machineCode,
    };
  }
  return { kind: 'unknown' };
}

/** @param {string} [search] */
export function parseSearchParams(search) {
  const q = new URLSearchParams(search || '');
  const tab = q.get('tab');
  return { tab: tab && tab.trim() ? tab.trim() : null };
}

/** @param {string} moduleId */
export function pathForModule(moduleId) {
  const map = {
    'plan-montaze': '/plan-montaze',
    'lokacije-delova': '/lokacije-delova',
    'plan-proizvodnje': '/plan-proizvodnje',
    'pracenje-proizvodnje': '/pracenje-proizvodnje',
    kadrovska: '/kadrovska',
    sastanci: '/sastanci',
    podesavanja: '/podesavanja',
    'odrzavanje-masina': '/maintenance',
  };
  return map[moduleId] || '/';
}

/**
 * Deep link na detalj mašine (isto kao u spec-u Telegram poruke).
 * @param {string} machineCode npr. rj_code iz BigTehn cache-a
 * @param {string | null} [tab] npr. 'checks'
 */
export function buildMaintenanceMachinePath(machineCode, tab = null) {
  const enc = encodeURIComponent(machineCode);
  const base = `/maintenance/machines/${enc}`;
  if (tab) return `${base}?tab=${encodeURIComponent(tab)}`;
  return base;
}

/**
 * Deep link na detalj sastanka.
 * @param {string} sastanakId UUID
 * @param {string | null} [tab] npr. 'zapisnik'
 */
export function buildSastanakDetaljPath(sastanakId, tab = null) {
  const base = `/sastanci/${sastanakId}`;
  if (tab) return `${base}?tab=${encodeURIComponent(tab)}`;
  return base;
}
