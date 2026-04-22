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
| **Pregled po lokacijama** | Server-side izveštaj kroz RPC **`loc_report_parts_by_locations`** (v2: join na BigTehn RN, kupac, projekat, materijal, dimenzija, težina, rok, status_rn, revizija). Filteri: crtež/ID/`broj_crteza` (BigTehn), broj naloga ili `ident_broj`, TP (`item_ref_id`), pretraga lokacije, projekat. Sort po više kolona uklj. **Rok**, paginacija 25/50/100/250, **Export CSV** (proširen na 23 kolone), per-row akcije: **Istorija**, **📋 RN/TP** (otvara `openTechProcedureModal`) i **TP nalepnica**. |
| **Istorija** | `loc_location_movements` sa filterima: pretraga (crtež ili nalog), striktan nalog, lokacija (od ili do), korisnik (vidljiv ako `loadUsersFromDb` vrati više od jednog korisnika), tip kretanja, datum od/do, reset, **Export CSV**, paginacija. |
| **Sync** | Samo admin: poslednjih 100 redova outbound queue (status, movement id, vreme, greška). |

---

## Alatna traka

- **Skeniraj** — ako postoji kamera (`getUserMedia`); `scanModal.js` (ZXing lazy-load).
- **Brzo premeštanje** — `modals.js`, ista poslovna logika bez kamere.
- **🔎 Crtež / RN** — `lookupModals.js` → pretraga `bigtehn_work_orders_cache` po `broj_crteza`/`ident_broj`/`naziv_dela`; klik na red otvara `openTechProcedureModal({ work_order_id })` (operacije + prijave iz `bigtehn_tech_routing_cache`).
- **🔎 Predmet** — pretraga `bigtehn_items_cache` po `broj_predmeta`/`naziv_predmeta`/`broj_ugovora`/`broj_narudzbenice`.
- **Nova lokacija** · **Nalepnice polica** — samo `canEdit()`.

**Nalepnice police** (`labelsPrint.js`): bira se **jedna polica** preko picker-a → browser print (Code128 nad `location_code`). Bulk štampa svih polica je uklonjena.

**Nalepnice TP** (`labelsPrint.js`): poziva se iz reda u tabu „Pregled po lokacijama”. Modal nudi izbor RNZ ili kratkog barkoda preko encoder-a `formatBigTehnRnzBarcode` / `formatBigTehnShortBarcode` u `src/lib/barcodeParse.js` (round-trip sa `parseBigTehnBarcode`). Default je browser print; ako je postavljen `VITE_LABEL_PRINTER_PROXY_URL`, šalje payload na network printer proxy (`dispatchOptionalNetworkLabelPrint`).

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

Izveštaj „Pregled po lokacijama” koristi RPC **`loc_report_parts_by_locations(...)`** (`add_loc_report_by_locations_rpc.sql` + v2 `add_loc_report_v2_bigtehn_columns.sql`): `SECURITY INVOKER`, prazan rezultat ako nema `auth.uid()` ili ako `loc_auth_roles()` vrati prazno; `REVOKE FROM anon`, `GRANT EXECUTE TO authenticated`. Vraća `jsonb { total, rows }` sa joinovima na `bigtehn_work_orders_cache` (uklj. `materijal`, `dimenzija_materijala`, `tezina_obr`, `status_rn`, `revizija`, `rok_izrade`, `work_order_id`), `bigtehn_customers_cache`, `projekt_bigtehn_rn`, `projects`. Filter `p_drawing_no` traži i po `broj_crteza` iz BigTehn-a; `p_order_no` poklapa i `ident_broj`. Sort whitelist proširen sa `rok_izrade`.

BRIDGE sync (MSSQL → Supabase): tabele `bigtehn_*_cache` puni eksterni servis; banner na **Početna** tabu Lokacija prikazuje upozorenje ako su `production_work_orders/_lines/_tech_routing` stariji od 6h, `catalog_items` stariji od 36h ili `production_bigtehn_drawings` stariji od 7 dana (zasnovano na `bridge_sync_log.finished_at`).

Virtualne lokacije (npr. ugrađeno, proizvodnja, otpis) su običan red u `loc_locations` odgovarajućeg tipa; pomeranje = `TRANSFER` s količinom.

**Redosled primene (tipično):**  
`add_loc_module_step1_tables.sql` (ako treba) → `add_loc_module.sql` → `add_loc_step2_ci_unique.sql` → `add_loc_step3_cleanup.sql` → opciono `add_loc_step4_pgcron.sql`, `add_loc_step5_sync_rpcs.sql` → `add_loc_v2_quantity.sql` → `add_loc_v3_order_scope.sql` → `add_loc_v4_drawing_no.sql` → **`add_loc_menadzment_manage_locations.sql`**.

Jednokratni seed: `sql/seed/loc_seed_bigtehn_positions.sql`.

---

## Kod u repou

`src/ui/lokacije/` — `index.js`, `modals.js`, `scanModal.js`, `labelsPrint.js`, `lookupModals.js`  
`src/services/lokacije.js` (servis za RPC `loc_report_parts_by_locations` i `fetchAll…`) · `src/state/lokacije.js` (tab `report`, filteri, sort, paginacija) · `src/lib/lokacijeFilters.js` · `src/lib/barcodeParse.js` (parser + encoderi `formatBigTehnRnzBarcode`/`formatBigTehnShortBarcode`)  
Mobilno: `src/ui/mobile/mobileHome.js`, `mobileLookup.js`, `mobileHistory.js`, `mobileBatch.js`  
Stil: `src/styles/legacy.css` (prefiks `loc-`)  
PWA: `docs/MOBILE.md`

---

## Konvencije

- Uloge iz tabele **`user_roles`**, ne iz JWT `app_metadata`.
- App: Vite + vanilla JS; navigacija kroz `router.js`, ne React Router.
- Ne menjaj nasumično `STORAGE_KEYS` u `lib/constants.js` (kompatibilnost keša korisnicima).
