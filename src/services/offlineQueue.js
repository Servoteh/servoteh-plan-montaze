/**
 * Offline queue za premeštanja. Kada korisnik skenira/unese nešto dok je
 * telefon bez WiFi-ja, payload za `loc_create_movement` se upisuje lokalno
 * u localStorage — i automatski se šalje na prvi `online` event (ili kad
 * korisnik klikne "⏳ X čeka" badge na home ekranu).
 *
 * ZAŠTO localStorage a ne IndexedDB:
 *   - Ne očekujemo više od ~100 zapisa u queue-u čak ni u najgorem scenariju
 *     (1h bez WiFi + aktivni radnik = 30-50 skeniranja).
 *   - Payloadi su mali (~300B), dakle <50KB ukupno → ok za localStorage 5MB
 *     limit.
 *   - Sinhrona API umanjuje broj race condition-a sa UI-em.
 *   - IndexedDB tek bi imao smisla kad bismo kešovali i lokacije, korisnike,
 *     Supabase session… što je Faza 2+ priča.
 *
 * FORMAT REDA:
 *   {
 *     id: 'Q-<timestamp>-<rand>',
 *     createdAt: ISO string,
 *     attempts: number,        // koliko puta smo pokušali da pošaljemo
 *     lastError: string|null,
 *     payload: { item_ref_table, item_ref_id, order_no, to_location_id, ... }
 *   }
 *
 * IDEMPOTENTNOST:
 *   Supabase RPC `loc_create_movement` NIJE idempotentna (svaki poziv kreira
 *   novi movement). Znači u slučaju retry-a posle mrežnog bug-a moramo paziti
 *   da isti zapis ne pošaljemo 2x. Rešavamo tako što red uklanjamo IZ queue-a
 *   ODMAH nakon `ok: true` odgovora — ako upload uspe ali odgovor ne stigne
 *   (WiFi pad u sred roundtrip-a), kreiraćemo duplikat. Za prvi deployment
 *   to je prihvatljivo (admin u istoriji vidi par duplikata i briše ih).
 *   Budućnost: dodati klijent-generisani `event_id` u payload i DB unique
 *   constraint na njega.
 */

import { locCreateMovement } from './lokacije.js';

const STORAGE_KEY = 'm.offlineQueue.v1';
const MAX_QUEUE_SIZE = 500; /* Safety cap — ako neko zaboravi uključi WiFi. */
const MAX_ATTEMPTS = 10;

/** @typedef {object} MovementPayload
 * @property {string} item_ref_table
 * @property {string} item_ref_id
 * @property {string} order_no
 * @property {string} to_location_id
 * @property {string} [from_location_id]
 * @property {string} movement_type
 * @property {number} quantity
 * @property {string} [note]
 */

/** @typedef {object} QueueEntry
 * @property {string} id
 * @property {string} createdAt
 * @property {number} attempts
 * @property {string|null} lastError
 * @property {MovementPayload} payload
 */

function readQueue() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.warn('[offlineQueue] corrupted queue, resetting', e);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    return [];
  }
}

function writeQueue(queue) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  } catch (e) {
    /* Quota exceeded — u najgorem slučaju izgubićemo novi unos (ne stari). */
    console.error('[offlineQueue] write failed', e);
  }
}

function genId() {
  return (
    'Q-' +
    Date.now().toString(36) +
    '-' +
    Math.random().toString(36).slice(2, 8)
  ).toUpperCase();
}

/**
 * Ubaci premestanje u queue. Vraća kreirani red (za UI feedback).
 * @param {MovementPayload} payload
 * @returns {QueueEntry}
 */
export function enqueueMovement(payload) {
  const queue = readQueue();
  if (queue.length >= MAX_QUEUE_SIZE) {
    throw new Error(`Queue pun (${MAX_QUEUE_SIZE}) — sinhronizuj prvo postojeće pre novog unosa.`);
  }
  const entry = {
    id: genId(),
    createdAt: new Date().toISOString(),
    attempts: 0,
    lastError: null,
    payload,
  };
  queue.push(entry);
  writeQueue(queue);
  return entry;
}

/** @returns {QueueEntry[]} */
export function listPendingMovements() {
  return readQueue();
}

/** @returns {number} */
export function countPendingMovements() {
  return readQueue().length;
}

/**
 * Ukloni red po `id`. Interno — koristimo nakon uspešnog upload-a.
 */
function removeEntry(id) {
  const queue = readQueue();
  const next = queue.filter(e => e.id !== id);
  if (next.length !== queue.length) writeQueue(next);
}

/**
 * Pokušaj da flush-uješ sve redove. Vraća agregat statistiku.
 *
 * @returns {Promise<{ok: number, failed: number, dropped: number}>}
 *   - `ok`      — uspešno poslato i obrisano iz queue-a
 *   - `failed`  — pokušano, neuspešno, ostaje za sledeći retry
 *   - `dropped` — previše pokušaja (`MAX_ATTEMPTS`), obrisano iz queue-a i
 *                 logovano u poseban "dead letter" log (zasad samo console)
 */
export async function flushPendingMovements() {
  const queue = readQueue();
  let ok = 0;
  let failed = 0;
  let dropped = 0;

  for (const entry of queue) {
    if (entry.attempts >= MAX_ATTEMPTS) {
      console.error('[offlineQueue] dropping entry (max attempts)', entry);
      removeEntry(entry.id);
      dropped += 1;
      continue;
    }

    entry.attempts += 1;
    try {
      const res = await locCreateMovement(entry.payload);
      if (res?.ok) {
        removeEntry(entry.id);
        ok += 1;
      } else {
        entry.lastError = res?.error || 'unknown_error';
        /* Ako je semantička greška (npr. bad_to_location) — retry neće pomoći.
         * Drop-uj posle prvog attempt-a da ne zaglavimo queue. */
        if (isFatalError(entry.lastError)) {
          console.warn('[offlineQueue] dropping due to fatal error', entry);
          removeEntry(entry.id);
          dropped += 1;
        } else {
          /* Ažuriraj attempts+lastError u storage-u. */
          persistEntry(entry);
          failed += 1;
        }
      }
    } catch (e) {
      entry.lastError = (e && e.message) || String(e);
      persistEntry(entry);
      failed += 1;
    }
  }

  return { ok, failed, dropped };
}

function isFatalError(code) {
  return (
    code === 'bad_to_location' ||
    code === 'bad_quantity' ||
    code === 'bad_order_no' ||
    code === 'not_authenticated'
  );
}

function persistEntry(entry) {
  const queue = readQueue();
  const idx = queue.findIndex(e => e.id === entry.id);
  if (idx >= 0) {
    queue[idx] = entry;
    writeQueue(queue);
  }
}

/**
 * Obriši sve (npr. za admin "reset queue" dugme — zasad ga nema u UI-u).
 */
export function clearPendingMovements() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    /* ignore */
  }
}

/* ── Auto-flush kad se vrati online ─────────────────────────────────────── */

let _autoFlushWired = false;
/**
 * Poziva se jednom prilikom bootstrap-a mobilnog shell-a. Instalira
 * `online` event listener na window koji pokušava flush kad se WiFi vrati.
 * Idempotentno — sigurno se može pozvati više puta.
 */
export function installAutoFlush() {
  if (_autoFlushWired) return;
  _autoFlushWired = true;
  window.addEventListener('online', async () => {
    if (countPendingMovements() === 0) return;
    try {
      await flushPendingMovements();
    } catch (e) {
      console.error('[offlineQueue] auto-flush failed', e);
    }
  });
}
