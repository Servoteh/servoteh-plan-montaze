# Lokacije delova — dokumentacija

**Jedini fajl u repou za ovaj modul.** Tehnički detalji triggere i kolona: `sql/migrations/add_loc_*.sql`.

---

## Uloga modula

Praćenje **gde se koja stavka nalazi** (magacin, police, WIP, virtuelne lokacije), **istorija pokreta** (append-only) i opciono **outbound sync** prema spoljnom sistemu. Premeštanje u aplikaciji ide isključivo kroz RPC **`loc_create_movement(jsonb)`**; on upisuje `loc_location_movements`, a triggeri održavaju `loc_item_placements`.

---

## Pristup

| | |
|--|--|
| **Ko vidi modul** | Svi ulogovani korisnici — `canAccessLokacije()` u `src/state/auth.js` |
| **Hub / router** | `sessionStorage` modul `lokacije-delova` · `src/ui/router.js` |
| **Tab „Sync”** | Samo **admin** (`canViewLokacijeSync()`) — čitanje `loc_sync_outbound_events` (RLS: `loc_is_admin()`) |
| **Master lokacija** (nova, izmena, aktivacija) i **nalepnice** | Dugmici za `canEdit()`: `admin`, `leadpm`, `pm`, `menadzment` — usklađeno sa RLS: **`loc_can_manage_locations()`** uključuje iste uloge (migracija `add_loc_menadzment_manage_locations.sql` ako starija baza nema `menadzment`) |
| **Skeniraj / Brzo premeštanje** | Svi ulogovani (pokret preko `loc_create_movement`, `GRANT` za `authenticated`) |

---

## Tabovi (UI)

Implementacija: `src/ui/lokacije/index.js` (`TABS`). Aktivni tab: `STORAGE_KEYS.LOC_TAB` → `plan_montaze_loc_active_tab_v1`.

| Tab | Sadržaj |
|-----|---------|
| **Početna** | KPI: broj aktivnih lokacija, broj redova u `loc_item_placements` (do 500 za KPI), lista poslednjih premeštanja. Ako su lokacije i stavke prazne, **first-run** blok (koraci) za korisnike sa `canEdit()`, inače kratka poruka. |
| **Lokacije** | Tabela ili stablo, pretraga (šifra/naziv/putanja), „Prikaži neaktivne”, akcije Izmeni / Aktiviraj ako `canEdit()`. |
| **Stavke** | Trenutna zaduženja: kolone tabela, crtež (ID), nalog, lokacija, količina, status. Pretraga na serveru (ILIKE), paginacija 25/50/100/250, **Export CSV**. Klik na red → istorija te stavke. |
| **Istorija** | `loc_location_movements` sa filterima: pretraga (crtež ili nalog), striktan nalog, lokacija (od ili do), korisnik (vidljiv ako `loadUsersFromDb` vrati više od jednog korisnika), tip kretanja, datum od/do, reset, **Export CSV**, paginacija. |
| **Sync** | Samo admin: poslednjih 100 redova outbound queue (status, movement id, vreme, greška). |

---

## Alatna traka

- **Skeniraj** — ako postoji kamera (`getUserMedia`); `scanModal.js` (ZXing lazy-load).
- **Brzo premeštanje** — `modals.js`, ista poslovna logika bez kamere.
- **Nova lokacija** · **Nalepnice polica** — samo `canEdit()`.

Kretanje uključuje **količinu** (v2) i **broj radnog naloga** (v3) gde je predviđeno u šemi; detalje vidi migracije ispod.

---

## Baza (glavno)

| Tabela | Uloga |
|--------|--------|
| `loc_locations` | Master hijerarhija |
| `loc_location_movements` | Istorija; insert samo kroz `loc_create_movement` |
| `loc_item_placements` | Trenutno stanje (trigger) |
| `loc_sync_outbound_events` | Outbound queue (worker) |

Evolucija: **v2** količina / višestruki placement — `add_loc_v2_quantity.sql` · **v3** `order_no` — `add_loc_v3_order_scope.sql` · **v4** `drawing_no` — `add_loc_v4_drawing_no.sql`.

Virtualne lokacije (npr. ugrađeno, proizvodnja, otpis) su običan red u `loc_locations` odgovarajućeg tipa; pomeranje = `TRANSFER` s količinom.

**Redosled primene (tipično):**  
`add_loc_module_step1_tables.sql` (ako treba) → `add_loc_module.sql` → `add_loc_step2_ci_unique.sql` → `add_loc_step3_cleanup.sql` → opciono `add_loc_step4_pgcron.sql`, `add_loc_step5_sync_rpcs.sql` → `add_loc_v2_quantity.sql` → `add_loc_v3_order_scope.sql` → `add_loc_v4_drawing_no.sql` → **`add_loc_menadzment_manage_locations.sql`**.

Jednokratni seed: `sql/seed/loc_seed_bigtehn_positions.sql`.

---

## Kod u repou

`src/ui/lokacije/` — `index.js`, `modals.js`, `scanModal.js`, `labelsPrint.js`  
`src/services/lokacije.js` · `src/state/lokacije.js` · `src/lib/lokacijeFilters.js`  
Mobilno: `src/ui/mobile/mobileHome.js`, `mobileLookup.js`, `mobileHistory.js`, `mobileBatch.js`  
Stil: `src/styles/legacy.css` (prefiks `loc-`)  
PWA: `docs/MOBILE.md`

---

## Konvencije

- Uloge iz tabele **`user_roles`**, ne iz JWT `app_metadata`.
- App: Vite + vanilla JS; navigacija kroz `router.js`, ne React Router.
- Ne menjaj nasumično `STORAGE_KEYS` u `lib/constants.js` (kompatibilnost keša korisnicima).
