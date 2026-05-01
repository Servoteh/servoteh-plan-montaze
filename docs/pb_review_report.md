# Projektni biro — Code Review Report

**Datum:** 30. april 2026.  
**Reviewer:** Cursor Agent  

## Sažetak nalaza

| ID | Oblast | Opis | Prioritet | Status |
|----|--------|------|-----------|--------|
| R01 | SQL | `pb_tasks` bez CHECK-a za plan/real datume | VISOK | POPRAVLJENO (`add_pb_constraints.sql`) |
| R02 | SQL | `pb_tasks` bez eksplicitne DELETE politike (samo admin + fizičko brisanje) | SREDNJI | POPRAVLJENO |
| R03 | SQL | Indeksi za dispatch poll i dedup na `pb_notification_log` | SREDNJI | POPRAVLJENO |
| R04 | SQL | `pb_enqueue_notifications`: prazan `email_recipients`, TZ za „danas“, overload izolovano od greške | SREDNJI | POPRAVLJENO (`add_pb_notifications.sql`) |
| R05 | SQL | SECURITY DEFINER — već `SET search_path = public, pg_temp` | INFO | POTVRĐENO |
| R06 | SQL | `pb_notification_log` INSERT za `authenticated` — nema politike (samo GRANT SELECT) | INFO | OK |
| R07 | JS | `sbReq` vraća `null` bez bacanja — slab UX za greške | VISOK | POPRAVLJENO (`sbReqThrow` + `pb.js`) |
| R08 | JS | `softDeletePbTask` bez `deleted_at IS NULL` u filteru | SREDNJI | POPRAVLJENO |
| R09 | JS | Validacija create/update task i work report pre API-ja | SREDNJI | POPRAVLJENO |
| R10 | JS | `getPbWorkReports` bez limita — rizik velikog payload-a | SREDNJI | POPRAVLJENO (default limit 500; index učitava godinu sa limitom) |
| R11 | UI | Modul bez error stanja pri `loadAll` | VISOK | POPRAVLJENO |
| R12 | UI | Toast bez tipa (success/error) | NIZAK | POPRAVLJENO (`showPbToast` + CSS) |
| R13 | UI | Kanban bez optimistic UI | SREDNJI | POPRAVLJENO (rollback na grešku) |
| R14 | UI | Gantt — akumulacija listenera pri re-renderu | SREDNJI | POPRAVLJENO (`AbortController` + delegacija) |
| R15 | UI | Izveštaji — mikrofon bez globalnog cleanup-a | SREDNJI | POPRAVLJENO (`stopPbIzvestajiSpeech` pri napuštanju taba) |
| R16 | UI | Analiza — prazan projekat / svi završeni | NIZAK | POPRAVLJENO (poruke) |
| R17 | Edge | Auth / `X-Audit-Actor` / timeout Resend / ukupni budget vremena | SREDNJI | POPRAVLJENO |
| R18 | Perf | `pb_get_load_stats` može biti skup na velikim skupovima | INFO | DOKUMENTOVANO (E1 — bez izmene bez potvrde) |

## Detalji po nalazu

### R01–R03, R05–R06 (SQL)

- **Constraint-i** `pb_tasks_dates_check` i `pb_tasks_real_dates_check` dodati u `sql/migrations/add_pb_constraints.sql` (aditivno). Ako migracija padne zbog postojećih loših redova, potrebno je ručno ispraviti podatke pa ponovo pokrenuti.
- **DELETE na `pb_tasks`:** politika `pb_tasks_delete_admin_hard` + `GRANT DELETE` samo uz `current_user_is_admin()`. Soft-delete i dalje preko `UPDATE deleted_at`.
- **Notifikacije:** `pb_notif_log_dispatch_idx` i `pb_notif_log_dedup_idx` za česte upite.
- **SECURITY DEFINER:** `pb_get_load_stats`, `pb_enqueue_notifications`, `pb_dispatch_*` već imaju `SET search_path = public, pg_temp`.
- **`pb_notification_log`:** nema `INSERT` politike za `authenticated`; korisnici ne mogu direktno ubacivati redove (samo `service_role` / DEFINER tokovi).

### R04 (`pb_enqueue_notifications`)

- Rani `RETURN 0` kada je `email_recipients` prazan.
- `v_today` u Evropi/Belgrade za dedup po danu.
- Sekcija overload u `BEGIN … EXCEPTION` da pad `pb_get_load_stats` ne prekine deadline/blocked grane.

### R07–R10 (servis)

- Novi `sbReqThrow` u `src/services/supabase.js` — parsira PostgREST grešku i postavlja `err.code` gde je moguće.
- `pb.js` koristi `sbReqThrow` za CRUD/liste; `quickUpdatePbTaskStatus` ostaje sa eksplicitnim status kodom.
- `softDeletePbTask` filtrira `deleted_at=is.null`.
- `deletePbWorkReport` sada baca na HTTP grešci (UI u Izveštajima hvata u `try/catch`).

### R11–R16 (UI)

- `index.js`: skeleton pri učitavanju, `try/catch` oko `Promise.all`, retry dugme; Izveštaji: `loadWorkReports` za tekuću godinu (limit), greška pri učitavanju; `stopPbIzvestajiSpeech` pri napuštanju taba Izveštaji.
- `shared.js`: `pbErrorMessage`, `showPbToast`, try/catch u editor modalu i `confirmDeletePbTask`.
- `kanbanTab.js`: optimistic premestanje kartice + rollback.
- `ganttTab.js`: jedan `AbortController` po renderu; delegacija klikova.
- `izvestajiTab.js`: try/catch, sakriven mikrofon ako nema API-ja.
- `analizaTab.js`: poruka kada nema projekata sa zadacima; zelena poruka kada su svi zadaci završeni.

### R17 (Edge)

- `pb-notify-dispatch`: obavezna `Authorization`, podrazumevani audit actor `pb-cron/system`, log jednom po zahtevu, `AbortSignal` na Resend (10 s), `MAX_DURATION_MS` 45 s, upozorenje ako nema `RESEND_API_KEY`.

### R18 (performanse SQL)

- Preporuka: `EXPLAIN ANALYZE SELECT * FROM pb_get_load_stats(30)` na produkciji. Ako je > 500 ms pri očekivanom volumenu, razmotriti klijentski proračun (ne implementirano ovde).

## Optimizacije

- Paralelni `Promise.all` u `loadAll` zadržan; dodato error stanje i skeleton.
- Kanban: manje punih reload-ova pri vizuelnom uspehu (i dalje refresh na uspeh za konzistentnost sa serverom — može se smanjiti u PB4).
- Gantt: manje curenja memorije pri navigaciji meseca.

## TODO za PB4 / PB5

| Ref | Prioritet | Kratak opis |
|-----|-----------|-------------|
| F1 | Visok | Veza `pb_tasks` → BigTehn RN (`bigtehn_rn_id`) |
| F2 | Visok | Load stats uključuje i `phases` (Plan montaže) |
| F3 | Srednji | UI „Istorija” iz `audit_log` |
| F4 | Srednji | Excel (Plan) / PDF (Analiza) export |
| F5 | Srednji | Lične notifikacije inženjeru |
| F6 | Nizak | Ponavljajući zadaci (RRULE) |
| F7 | Nizak | Heatmap opterećenja u Analizi |

Komentari `TODO(PB4)` / `TODO(PB5)` u kodu upućuju na ovaj dokument.

## Testovi — coverage gap

- **Vitest:** `ganttBarGeometry`, `izvestajiObracun` — nisu dodati novi testovi za `pbErrorMessage` / `sbReqThrow` (niska prioritet).
- **pgTAP:** `security_pb_rls.sql`, `security_pb_notifications.sql` — nisu prošireni za nove constraint-e i DELETE politiku; preporuka: dodati `lives_ok`/`throws_ok` posle primene `add_pb_constraints.sql` na CI bazi.

## Primena migracija na okruženju

- Pokrenuti **`sql/migrations/add_pb_constraints.sql`** na Supabase (nakon review-a ako postoje podaci koji krše CHECK).
