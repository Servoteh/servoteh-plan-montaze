# Modul: Lokacije delova — uputstvo za agenta (usklađeno sa ovim repo-om)

Dokument nadovezuje na spoljašnju specifikaciju (*Modul_Lokacije_Delova_Specifikacija.md*) i sprečava implementaciju pogrešnog stack-a ili uloga.

---

## Kako pokrenuti „Agent B” u Cursor-u

Cursor nema posebno dugme „Agent A / Agent B” — to je vaša oznaka za **drugi, odvojeni kontekst**:

1. Otvorite **Composer** ili **Chat** (npr. **Ctrl+I** / **Cmd+I** za Composer, ili ikona četa u bočnoj traci).
2. Započnite **novu sesiju**: **+** / **New chat** / **New Composer** da Agent B **ne nasledi** kontekst drugog agenta.
3. U tom prozoru zakačite (`@`) repozitorijum i/ili ovaj fajl `docs/Modul_Lokacije.md`.
4. U **istom** chatu držite **jedan** glavni zadatak (npr. samo lokacije), da ne meša module.

Ako koristite **Background Agent** (ako je uključen u planu), ista logika: nova sesija, jasna prva poruka.

---

## Gde originalna spec (sekcija G) ne odgovara ovom repo-u

| Šta često piše spec | Šta je u `servoteh-plan-montaze` |
|---------------------|----------------------------------|
| React + TypeScript + TanStack Query + Zustand | **Vite + vanilla JS** (`package.json`, `README.md`). |
| `src/modules/locations/**/*.tsx` | Obrasci: `src/ui/<modul>/`, `src/services/`, `src/state/`, `main.js`, `router.js`. |
| React Router (`/locations/items/...`) | **Nema** URL rutera kao u Reactu; `router.js` koristi screen/module hub + `sessionStorage`. |
| Uloge: magacioner, tehnicar, sef | U bazi/kodu: **`admin`, `leadpm`, `pm`, `menadzment`, `hr`, `viewer`** (`user_roles`, migracije, `src/state/auth.js`). Spec uloge zahtevaju **migraciju** + proširenje `effectiveRoleFromMatches` u `src/services/userRoles.js`. |
| RLS primer sa `auth.jwt() -> 'app_metadata' ->> 'role'` | Aplikacija koristi **`user_roles`** + lookup; ne kopirati JWT primere slepo. |
| Design system iz npm paketa | **`src/styles/legacy.css`** + postojeći hub/kadrovska layout. |

**Zaključak:** Sekcije A–F (model `loc_*`, queue, worker, MSSQL) mogu ostati **konceptualno** iste; implementacija frontenda i autorizacije mora da prati **ovaj** repo.

---

## Čega se držati (bez greške)

1. **Ne uvoditi React** samo zbog ovog modula bez eksplicitne odluke tima.
2. **Ne vezivati RLS** za JWT `app_metadata` bez usklađivanja sa `user_roles` i postojećim helperima.
3. **Ne uvoditi uloge** magacioner/tehnicar/sef bez migracije `user_roles` CHECK-a i ažuriranja `effectiveRoleFromMatches` / `auth.js` — inače rola može pasti na `viewer` ili biti nepoznata.
4. **Service role** samo u workeru, nikad u frontendu (kao u specifikaciji).
5. Pre UI-ja potvrditi **koji Supabase view/tablе** drže delove/sklopove/alate i **koje MSSQL kolone** write-back menja.

---

## Instrukcija za agenta (copy-paste kao prva poruka u novoj sesiji)

```
# AGENT — Modul Lokacije delova (usklađeno sa repo-om servoteh-plan-montaze)

## Obavezni tehnički kontekst (NE ignoriši)
- Repo je Vite 5 + vanilla JavaScript (ES modules), bez React-a, bez TypeScript-a, bez TanStack Query, bez Zustand.
- UI: postojeći obrasci u src/ui/ (tabovi, modali), stilovi u src/styles/legacy.css.
- API: src/services/supabase.js (sbReq), auth u src/state/auth.js, uloge iz tabele user_roles preko src/services/userRoles.js (loadAndApplyUserRole, effectiveRoleFromMatches).
- Navigacija: src/ui/router.js + module hub — nije React Router. Novi modul: novi screen ili novi entry u hub-u, konzistentno sa plan-montaze, kadrovska, itd.

## Šta preuzmi iz spoljašnje specifikacije (sekcije A–F)
- Polimorfna tabela loc_locations, loc_item_placements, loc_location_movements (append-only), loc_sync_outbound_events.
- Queue + Node worker + MSSQL SP sa idempotency — kao u specifikaciji.
- Quick Move, path_cached, triggeri — kao u specifikaciji.

## Obavezne izmene u odnosu na generičku „React“ instrukciju
1. Ne kreirati src/modules/locations/**/*.tsx. Umesto toga npr. src/ui/lokacije/ (ili dogovoreno ime) sa .js fajlovima koji prate stil ostalih modula.
2. Ne uvoditi TanStack Query/Zustand; server state: async funkcije + eventualno mali state u src/state/ ili lokalno u modulu; prati postojeći pattern iz drugog modula.
3. Uloge: pre implementacije RLS/UI matrice odlučiti: (a) proširiti user_roles.role migracijom za uloge iz specifikacije (magacioner, tehnicar, sef…) ili (b) mapirati ih na postojeće (admin, pm, …) i dokumentovati mapiranje. Ažurirati effectiveRoleFromMatches i auth.js helper-e da nova rola ne padne na viewer.
4. RLS i RPC: praviti u skladu sa email + user_roles modelom koji aplikacija već koristi, ne slepo kopirati JWT app_metadata primere.
5. Acceptance kriterijume prilagoditi: virtualizacija lista ako eksplicitno dodate zavisnost; keyboard shortcuts i i18n po dogovoru.

## Redosled (predlog)
1. SQL migracije + enum-i + triggeri (sql/migrations/).
2. RLS + loc_create_movement RPC (SECURITY DEFINER).
3. Servisi u src/services/lokacije*.js + tanak state po potrebi.
4. UI shell u hub-u + ekrani (dashboard, lista, detalj, browser, sync za admin).
5. Worker u odvojenom folderu ili repo-u kao u specifikaciji.

## Pre pisanja koda — od tima dobiti odgovore
- Tačni Supabase objekti za stavke (parts/tools/assemblies).
- Tačne MSSQL kolone za write-back i da li sync_processed_events već postoji.
- Da li postoji dokumentacija Servoteh dizajn tokena (ako ne — prati legacy.css i postojeće module).
```

---

## Referenca

- Spoljašnja specifikacija: `Modul_Lokacije_Delova_Specifikacija.md` (prilozi sa strane).
- Repo: `README.md`, `MIGRATION.md`, `sql/schema.sql`, `sql/migrations/`.

---

## v2 — Quantity + multi-placement (obavezno za probu)

BigTehn model zahteva da **ista stavka može biti istovremeno na više lokacija sa različitim količinama** (tipičan primer: jedan broj naloga ima 50 komada, 2 na K-C3, 6 na K-B2, 5 ugrađenih, ostatak u proizvodnji). Zato je uvedena migracija `sql/migrations/add_loc_v2_quantity.sql` koja:

1. Dodaje `quantity NUMERIC(12,3) NOT NULL DEFAULT 1 CHECK (> 0)` na `loc_item_placements` i `loc_location_movements`.
2. Zamenjuje unique constraint sa `(item_ref_table, item_ref_id)` na `(item_ref_table, item_ref_id, location_id)`.
3. Trigger `loc_after_movement_insert` radi aritmetiku umesto overwrite-a (`TO += qty`, `FROM -= qty`, brisanje reda kad qty ≤ 0).
4. RPC `loc_create_movement` prima `quantity` i validira kapacitet na `from_location_id` pre INSERT-a.

Redosled primene migracija:
```text
sql/migrations/add_loc_module.sql
sql/migrations/add_loc_step2_ci_unique.sql        (ako nije primenjeno ranije)
sql/migrations/add_loc_step3_cleanup.sql
sql/migrations/add_loc_step4_pgcron.sql           (opciono — pg_cron retention)
sql/migrations/add_loc_step5_sync_rpcs.sql        (opciono — worker RPCs)
sql/migrations/add_loc_v2_quantity.sql            ← OVO JE NOVO
```

### Virtualne lokacije

Za delove koji napuštaju fizičko skladište uvode se **virtualne lokacije** koje sede uz master lokacije u istoj tabeli `loc_locations`:

| Kod           | Tip (enum)  | Kada se koristi                                              |
|---------------|-------------|--------------------------------------------------------------|
| `UGRADJENO`   | `ASSEMBLY`  | Deo je ugrađen u finalni proizvod — izlazi iz bilansa.      |
| `PROIZVODNJA` | `PRODUCTION`| Deo je u radnom procesu (WIP), nije još završen.            |
| `OTPISANO`    | `SCRAPPED`  | Škart / otpis.                                               |

Tako „ugradnja 5 komada“ je običan TRANSFER iz fizičke police u `UGRADJENO`, evidentiran kao pokret sa `quantity=5`. Nikakav novi enum/RPC.

### Jednokratan seed iz BigTehn-a

Fajl `sql/seed/loc_seed_bigtehn_positions.sql` je **one-shot** skripta:
- Sekcija A kreira root `MAG` + virtualne lokacije (idempotentna).
- Sekcija B očekuje da se VALUES lista zameni realnim redovima iz `SELECT Pozicija, Opis FROM dbo.tPozicije`. Excel formula za generisanje VALUES reda data u komentarima skripte.
- Ne ide nikakva replikacija nazad u MSSQL — nova aplikacija je autoritet za sve operacije nakon seed-a.

### UI — Brzo premeštanje (v2)

Modal sada:
- Prikazuje **live** trenutne placement-e za uneseni `item_ref_id` (chips: `K-C3 · 4`).
- Auto-prebacuje `movement_type` na `TRANSFER` ako stavka već postoji negde, odnosno `INITIAL_PLACEMENT` ako ne postoji.
- `from_location` select se popunjava isključivo lokacijama gde ima stanja, sa prikazanom količinom.
- Prikazuje `max` i hint pored `quantity` input-a kada je `from` izabran.
- Validacija na klijentu (qty > 0, from ≠ to) + detaljne server-side poruke (`insufficient_quantity` vraća `available`/`requested`).

---

## Mobilni tok rada: skeniranje barkoda + istorija

### Faza A — Skener (Lokacije → dugme „📷 Skeniraj")

- Puni ekran, kamera okrenuta unazad, flash (ako uređaj to podržava).
- Radi na Android Chrome, iOS Safari (iOS 17+) i desktop browserima sa kamerom.
- Biblioteka `@zxing/browser` se **lazy-loaduje** (~410KB JS samo po otvaranju modala), tako da početni bundle ostaje mali.
- Posle skena: automatsko prebacivanje u formu sa popunjenim `item_ref_id`, prikazom postojećih placement-a, predlogom `from_location`/`quantity`. Dovoljno je izabrati `to_location` i pritisnuti Sačuvaj.
- Fallback: dugme „Ručni unos" ako kamera zakaže.
- **Napomena o BigTehn nalepnicama:** iPhone Camera trenutno iz tih nalepnica čita samo broj crteža. To je dovoljno za `item_ref_id = <broj_crteža>`, ali značajno je da **jedan broj crteža može biti na više radnih naloga**; ako UI kasnije doda izbor radnog naloga, izmena je lokalizovana na `scanModal.js` (između `showForm` i `submit`).

### Faza B — Nalepnice polica (admin → „🏷 Nalepnice polica")

- Otvara poseban browser prozor sa print-ready HTML-om (A4, 3 kolone × 8 redova = 24 nalepnice po strani).
- Svaka nalepnica: veliki tekst koda + Code128 barkod (iscrtan kao SVG preko `jsbarcode`, lazy-import) + naziv lokacije.
- Filter: samo aktivne `SHELF | RACK | BIN` lokacije (virtualne i skladišta se preskaču).
- Štampa: `Ctrl+P` ili dugme „Štampaj" u top baru prozora.

### Faza C — Istorija (novi tab „Istorija")

- Paginirani pregled `loc_location_movements` sa filterima:
  - Pretraga po `item_ref_id` ili `order_no` (server-side ILIKE, OR filter).
  - „Samo nalog" — striktna jednakost `order_no=eq.<x>`.
  - Filter po lokaciji (OR `from`/`to`).
  - Filter po korisniku (prikazuje se samo za admine; RLS `user_roles_read_admin_all`).
  - Filter po `movement_type`.
  - Datumski opseg (`moved_at >= from`, `< to+1 dan`).
- CSV export celokupnog filtriranog skupa (batch po 500, HARD_CAP 50 000).
- Paginator whitelist veličina: 25, 50, 100, 250.
- State se čuva u `src/state/lokacije.js` (`historyFilters`, `historyPage`, `historyPageSize`); normalizacije u state funkcijama čuvaju od XSS/SQL injection kroz LS.

---

## v3 — `order_no` kao dimenzija (nalog × crtež × lokacija)

BigTehn nalepnica nosi `BROJ_NALOGA/BROJ_CRTEŽA` (npr. `9000/1091063`). Isti broj crteža može biti poručen na više različitih radnih naloga i zalihe iz pojedinog naloga ne smeju se mešati — ako operater ugradi 150 kom. crteža 1091063 sa naloga 9000, to ne sme da smanji stanje drugog naloga za isti crtež.

Migracija `sql/migrations/add_loc_v3_order_scope.sql`:

1. Dodaje `order_no TEXT NOT NULL DEFAULT ''` na `loc_item_placements` i `loc_location_movements` (max 40 karaktera, `''` je backward-compat bucket).
2. Menja unique constraint sa `(item_ref_table, item_ref_id, location_id)` na `(item_ref_table, item_ref_id, order_no, location_id)`.
3. Trigger `loc_after_movement_insert` radi aritmetiku po (crtež, nalog) bucketu.
4. RPC `loc_create_movement` prihvata `order_no` iz payload-a i koristi ga u svim proverama (`already_placed`, `from_ambiguous`, kapacitet).
5. Parcijalni indeksi `loc_location_movements_order_no_idx` i `loc_item_placements_order_no_idx` (`WHERE order_no <> ''`) za brzu filter pretragu.
6. Sync outbound payload dobija `order_no` polje (MSSQL strana će ga primiti kada se implementira `sp_ApplyLocationEvent`).

### UI uticaji
- **Skener (`scanModal.js`)** i **Brzo premeštanje (`modals.js`)** imaju odvojena polja „Broj naloga" i „Broj crteža". Ako je nalog prazan, prikaz pokazuje SVE naloge za taj crtež (agregirano po nalogu i lokaciji) — klik na chip popuni nalog i re-scope-uje.
- „Sa lokacije" dropdown aktivan je tek kada je nalog poznat, jer bez njega ne možemo sigurno odrediti iz kog bucketa oduzimamo.
- **Stavke tab**: nova kolona „Nalog". Klik na red otvara istoriju scope-ovanu na taj tačan (crtež, nalog) bucket. CSV export dobija kolonu „Nalog".
- **Istorija tab**: nova kolona „Nalog"; pretraga radi po crtežu ili nalogu; „Samo nalog" filter je striktna jednakost. CSV export dobija kolonu „Nalog".
- Klijent uvek šalje `order_no` u payload-u `loc_create_movement` (prazan string = backward-compat bucket).

### Redosled primene migracija
```text
… prethodne …
sql/migrations/add_loc_v2_quantity.sql
sql/migrations/add_loc_v3_order_scope.sql       ← OVO JE NOVO
```
