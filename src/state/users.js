/**
 * Podešavanja → Korisnici state.
 *
 * - usersState.items: lista user_roles redova (mapovani u camelCase).
 * - usersState.loaded: true posle prvog uspešnog DB load-a (ili posle
 *   prvog cache load-a u offline modu).
 *
 * Cache: localStorage[STORAGE_KEYS.USERS_CACHE], JSON niz mapovanih redova.
 * Identičan ključ kao legacy → cutover ne resetuje listu na prvi paint.
 */

import { lsGetJSON, lsSetJSON } from '../lib/storage.js';
import { STORAGE_KEYS } from '../lib/constants.js';

export const usersState = {
  items: [],
  loaded: false,
};

export function loadUsersCache() {
  return lsGetJSON(STORAGE_KEYS.USERS_CACHE, []) || [];
}

export function saveUsersCache(items) {
  lsSetJSON(STORAGE_KEYS.USERS_CACHE, items || []);
}

export function resetUsersState() {
  usersState.items = [];
  usersState.loaded = false;
}
