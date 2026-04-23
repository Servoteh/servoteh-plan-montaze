# Bezbednost Servoteh ERP — stanje i plan

> **Status:** živi dokument, verzija 1.0 (23. april 2026)
> **Vlasnik:** Nenad Jaraković
> **Skopi:** `servoteh-plan-montaze` repo (Plan Montaže + Kadrovska + Lokacije + Održavanje + Podešavanja).
> **Cilj dokumenta:** jedan izvor istine za bezbednosnu poziciju platforme i šta je urađeno u svakoj fazi hardening-a.

---

## 1. TL;DR — gde smo nakon Faze 1 (23. april 2026)

| Oblast | Pre Faze 1 | Posle Faze 1 |
|---|---|---|
| **Offline mode UX prevara** | Dugme uvek vidljivo, postavlja `pm` rolu u UI bez tokena | Sakriveno u produkciji; vidljivo samo uz `VITE_ENABLE_OFFLINE_MODE=true` (dev) |
| **`v_production_operations` data leak** | `GRANT SELECT ... TO anon` — javni anon ključ čita pun pregled proizvodnje | `REVOKE SELECT FROM anon` migracija; samo `authenticated` rola ima pristup |
| **`schema.sql` baseline** | Pilot `has_edit_role() RETURN true` + `roles_select USING(true)` | Stvarna provera uloga (admin/hr/menadzment/pm/leadpm) + `read_self` + `admin_write` politike |
| **CI guard protiv regresije** | Nije postojao | Novi `schema-baseline` job na svakom push/PR-u; 4 zabranjena pattern-a |
| **Test pokrivenost security skripte** | 0 testova | 7 Vitest testova (clean SQL prolazi, svaki rule lovi anti-pattern, komentari se ignorišu) |

**Ukupna ocena (pre → posle):**
RBAC: YELLOW → YELLOW · API security: RED → YELLOW · Audit log: GREEN → GREEN · Tenant izolacija: RED → RED (namerno; vidi §6) · Auth/AuthZ: YELLOW → YELLOW · Tests: RED → RED (nije Faza 1).

Faza 1 nije bila o globalnom skoku — zatvorena su 4 konkretna proboja koji su mogli da padnu prvi enterprise sigurnosni pregled (anon read na proizvodnju + UI dugme koje deluje kao prijava).

---

## 2. Arhitektonska podsetnica (kako bezbednost stvarno funkcioniše)

```
┌─────────────────┐    JWT (localStorage)    ┌─────────────────┐
│ Browser (Vite)  │ ───────────────────────► │ Supabase API    │
│ vanilla JS      │ ◄─────────────────────── │ (PostgREST +    │
│ src/services    │      JSON                │  auth + edge    │
└─────────────────┘                          │  functions)     │
                                              └────────┬────────┘
                                                       │
                                                       ▼
                                              ┌─────────────────┐
                                              │ Postgres + RLS  │
                                              │ user_roles      │
                                              │ audit_log (trg) │
                                              └─────────────────┘
```

**Pravila autorizacije po slojevima:**

1. **Browser/UI** — `src/state/auth.js` helperi (`canEdit()`, `isAdmin()`, `canManageUsers()`) **kontrolišu samo prikaz** (sakrivanje dugmadi). Ne računaju se kao bezbednost.
2. **PostgREST** — automatski dodaje `Authorization: Bearer <jwt>` u svaki REST poziv. Anon ključ ide u JS bundle (javan).
3. **Postgres RLS** — *jedino* mesto gde se autorizacija stvarno proverava. Politike koriste `auth.jwt()->>'email'` i `user_roles` tabelu.
4. **`SECURITY DEFINER` helper-i** (`has_edit_role`, `current_user_is_admin`, `current_user_is_hr_or_admin`) — bypass-uju rekurziju RLS-a, ali sami imaju `SET search_path` zaštitu od hijack-a.

**Ko ima `service_role` ključ (BYPASSRLS):**
- `supabase/functions/maint-notify-dispatch` (cron)
- `supabase/functions/hr-notify-dispatch` (cron)
- `workers/loc-sync-mssql` (Node worker za MSSQL → Supabase sync)

**Posledica:** sve što ovi izvršavaju je nevidljivo za RLS. Audit log ih hvata kroz triger `audit_row_change()`, ali bez `actor_email` (jer service_role nema JWT).

---

## 3. Faza 1 — šta je tačno urađeno (23. april 2026)

### 3.1 Offline mode iza env flag-a

**Problem:** Login ekran je imao "Nastavi offline" dugme koje:
- postavlja `setUser({ email: 'offline@local', _token: null })`
- postavlja `setRole('pm')` u UI

**Posledica:** Operater dobija UI utisak da je prijavljen kao PM. Pisanja zapravo padnu na RLS-u (jer `_token: null` znači da se pošalje anon ključ, a politike traže `TO authenticated`), ali ne pre nego što korisnik vidi spinnere i poluunete podatke. Osim toga, prikazani su mu cache-irani podaci kojima ne bi smeo da pristupa van svoje sesije.

**Ispravka:**
- Novi helper `isOfflineModeEnabled()` u `src/lib/constants.js` čita `VITE_ENABLE_OFFLINE_MODE`.
- `src/ui/auth/loginScreen.js` renderuje divider + dugme samo kada je flag `true`.
- `.env.example` dokumentuje flag kao **default OFF**, sa upozorenjem za šta služi.
- Production build (Cloudflare Pages — env nije postavljen) **uopšte ne renderuje** offline opciju.

**Evidencija u kodu:**
- `src/lib/constants.js:206-220` — `isOfflineModeEnabled()`
- `src/ui/auth/loginScreen.js:24-35` — `offlineEnabled` gate
- `.env.example:13-19` — dokumentacija flag-a

**Difficulty:** Low. **Risk if reverted:** medium (UX prevara, ne pravi data breach).

---

### 3.2 REVOKE anon SELECT na `v_production_operations`

**Problem:** Migracije `add_v_production_operations.sql` i `add_bigtehn_drawings.sql` su davale `GRANT SELECT ... TO anon` na view koji denormalizuje 5+ tabela (RN-ovi, kupci, mašine, rokovi, nazivi delova). Anon ključ je javni — bilo ko ko ima URL i anon key (a ima ih svako ko otvori dev tools u browseru) je mogao da povuče ceo proizvodni pregled bez ikakve autentifikacije.

**Ispravka:** Nova migracija `sql/migrations/revoke_anon_v_production_operations.sql`:

```sql
REVOKE SELECT ON public.v_production_operations FROM anon;
NOTIFY pgrst, 'reload schema';

-- Verifikacija (ne sme da vrati anon SELECT):
SELECT grantee, privilege_type
FROM   information_schema.role_table_grants
WHERE  table_schema = 'public' AND table_name = 'v_production_operations';
```

`authenticated` rola ostaje netaknuta — UI radi bez regresije. Migracija je idempotentna (REVOKE od nepostojeće role je no-op).

**Status u CI:** Privremeno *zakomentarisano* u `sql/ci/migrations.txt` jer CI lista ne uključuje pun plan-proizvodnje schema set, pa REVOKE na nepostojećem objektu pada. Pokreće se manuelno na Supabase posle deploy-a.

**Evidencija u kodu:** `sql/migrations/revoke_anon_v_production_operations.sql`

**Difficulty:** Low. **Risk if reverted:** **CRITICAL** — direktan data leak.

---

### 3.3 `sql/schema.sql` usklađen sa primenjenim migracijama

**Problem:** Pilot bootstrap (`sql/schema.sql`) je sadržao dva opasna pattern-a koja su kasnije migracije zatezale, ali je svaki ko bi resetovao bazu i pokrenuo *samo* `schema.sql` dobio otvoreni sistem:

1. `has_edit_role()` je bezuslovno vraćao `RETURN true;` — svaki autentifikovan korisnik je mogao da upiše/izbriše bilo šta.
2. `roles_select` politika je imala `USING (true)` — svako autentifikovan je mogao da čita ceo `user_roles` registar (mejlovi i role svih korisnika u sistemu).

**Ispravka u `sql/schema.sql`:**

- `has_edit_role()` sada proverava `user_roles` (sinhrono sa `add_menadzment_full_edit_kadrovska.sql`):
  - globalna rola `admin/hr/menadzment/pm/leadpm` (project_id IS NULL) → TRUE
  - per-project `pm/leadpm` na zadatom `proj_id` → TRUE
  - inače FALSE
- `SECURITY DEFINER + SET search_path = public, pg_temp` (zaštita od search_path hijack-a)
- Pilot `roles_select USING(true)` + `roles_manage` zamenjeni sa:
  - `user_roles_read_self` — svako vidi svoj red
  - `user_roles_read_admin_all` — admin vidi sve
  - `user_roles_admin_write` — INSERT/UPDATE/DELETE samo admin
- Dodato `ALTER TABLE user_roles FORCE ROW LEVEL SECURITY`
- Header sekcija upozorava na pravila (vidi `sql/schema.sql:1-22`)

**Evidencija u kodu:**
- `sql/schema.sql:1-22` — security usklađivanje header
- `sql/schema.sql` — nova `has_edit_role` definicija (sa SECURITY DEFINER)
- `sql/schema.sql` — `user_roles_read_self` / `_read_admin_all` / `_admin_write` politike

**Difficulty:** Low. **Risk if reverted:** CRITICAL — fresh deploy je otvoren.

---

### 3.4 CI guard protiv regresije

**Problem:** Bez automatske kontrole, neko mesecima kasnije može da copy-paste-uje pilot pattern nazad u `schema.sql` (npr. da debug-uje neki problem) i meriti to.

**Ispravka:**

1. **`scripts/check-schema-security-baseline.cjs`** — Node skripta koja proverava `sql/schema.sql` na 4 zabranjena pattern-a:
   - `has-edit-role-return-true` — `has_edit_role()` čije telo je samo `BEGIN RETURN true; END`
   - `roles-select-using-true` — `roles_select` politika sa `USING(true)`
   - `roles-manage-pilot` — pilot `roles_manage` politika
   - `grant-select-anon-v-production` — `GRANT SELECT ... TO anon` na `v_production_operations`

   Skripta strip-uje SQL komentare pre matching-a (da ne hvata primere u dokumentaciji), ima jasne `Problem` + `Popravka` poruke za svaki rule.

2. **`tests/scripts/schemaSecurityBaseline.test.js`** — 7 Vitest testova:
   - clean SQL prolazi sa exit 0
   - svaki rule individualno lovi regresiju (4 testa)
   - hardened `has_edit_role` (sa `RETURN true` u IF grani) ne baci false positive
   - SQL komentari (`-- ...` i `/* ... */`) se ignorišu

3. **`.github/workflows/ci.yml`** — novi `schema-baseline` job pre `js-tests` i `sql-tests`. Zaustavlja merge ako `schema.sql` regresira.

4. **`package.json`** — `npm run check:schema-baseline` skratica za lokalno pokretanje.

**Evidencija:**
- `scripts/check-schema-security-baseline.cjs`
- `tests/scripts/schemaSecurityBaseline.test.js`
- `.github/workflows/ci.yml` — `schema-baseline` job

**Difficulty:** Low–Medium. **Effect:** trajno zaključava 4 najteže regresije.

---

## 4. Trenutna bezbednosna pozicija (sa dokazom u kodu)

### 4.1 Šta JE solidno

| Oblast | Status | Evidencija |
|---|---|---|
| **Generic audit log** | GREEN | `sql/migrations/add_audit_log.sql` — `audit_log` tabela + `audit_row_change()` triger na 9 tabela (`employees`, `user_roles`, `salary_terms`, `salary_payroll`, `absences`, `work_hours`, `contracts`, `vacation_entitlements`, `employee_children`) |
| **Audit log RLS** | GREEN | `sql/migrations/add_audit_log.sql:60-75` — `audit_log_select_admin` (samo admin čita) + `audit_log_no_client_write` (`USING(false)` — nema direktnih client write-ova) |
| **HR sensitive data** | GREEN | `sql/migrations/add_kadr_employee_extended.sql:201-204` — `trg_employees_sensitive_guard` blokira non-HR/admin update na JMBG/bank account; `v_employees_safe` view (`342-430`) maskira osetljiva polja |
| **`employee_children` RLS** | GREEN | `add_kadr_employee_extended.sql:233-242` — politike traže `current_user_is_hr_or_admin()` |
| **Hard-delete sa audit-om** | GREEN | `sql/migrations/add_maint_machine_hard_delete.sql:130-223` — `maint_machine_delete_hard` RPC: provera role, validacija razloga, snapshot pre brisanja, log u `audit_log`, cascade cleanup |
| **`user_roles` UI INSERT blok** | GREEN | `src/services/users.js` — `saveUserToDb` proverava `canManageUsers()` pre svakog poziva; novi nalozi se dodaju kroz Supabase Studio (RLS bi svejedno blokirao, ovo je defense-in-depth) |
| **`user_roles` RLS posle Faze 1** | GREEN | `sql/schema.sql` + `enable_user_roles_rls_proper.sql` + `cleanup_user_roles_legacy_policies.sql` — read-self + admin-all + admin-write |
| **Schema baseline guard** | GREEN | `scripts/check-schema-security-baseline.cjs` u CI |

### 4.2 Šta je YELLOW (treba doraditi, ali nije akutno)

| Oblast | Status | Šta nedostaje |
|---|---|---|
| **RBAC matrica** | YELLOW | Nema dokumentovane matrice „rola × tabela × CRUD". Politike postoje, ali su raspoređene po 40+ migracija — niko nema overview. **Treba:** auto-generator iz `pg_policies` u markdown. |
| **Frontend authZ** | YELLOW | Helperi `canEdit()`, `isAdmin()` su konzistentni, ali rute (`src/ui/router.js`) ne proveravaju `plan-montaze` (samo Kadrovska/Podešavanja). U praksi RLS svejedno čuva, ali UI dozvoljava ulazak. |
| **Test pokrivenost RLS-a** | RED | Postoje pgTAP testovi samo za `loc_*` (`sql/tests/loc_module_behavior.sql`). Nema testova za: cross-user IDOR, privilege escalation, user_roles tampering, sensitive HR data leak. |
| **`SELECT USING(true)` na `sastanci_*` i `bigtehn_*`** | YELLOW | `sql/migrations/add_sastanci_module.sql:342-377` i nekoliko migracija plan-proizvodnje grant-uju `SELECT TO authenticated USING(true)`. Ovo je interno OK (svi zaposleni vide sve sastanke i RN-ove), ali za enterprise klijenta bi bilo problematično. |

### 4.3 Šta je RED (zna se, čeka pravi razlog)

| Oblast | Status | Razlog odlaganja |
|---|---|---|
| **Multi-tenancy** | RED | Sistem je single-tenant by design. Nema `tenant_id` ni na jednoj tabeli. **Refaktor sad bi koštao 6+ meseci za nula koristi** — namerno odložen do drugog klijenta (vidi `STRATEGIJA_ERP.md` §3.1). |
| **`--no-verify-jwt` Edge Functions** | RED | `supabase/functions/maint-notify-dispatch/index.ts:29` i `hr-notify-dispatch/index.ts:30` se deployuju sa `--no-verify-jwt`. Čuva ih URL secrecy + Supabase cron. **Treba:** webhook signature verification ili premestiti u DB cron. |
| **`localStorage` JWT** | RED (industry standard za SPA) | Token je u `localStorage` što je ranjivo na XSS. Industry alternativa (HTTP-only cookie) traži CSRF zaštitu i postavljanje subdomen-a — refaktor van okvira current arhitekture. |
| **Service-role atribucija** | YELLOW | `audit_row_change()` snima `actor_email = NULL` kad worker (service_role) menja podatke. Treba prosleđivati `actor_email` kroz `SET LOCAL` u session-u. |
| **Bulk operacije** | YELLOW | Nekoliko UI flow-ova (kadrovska grid, lokacije import) izvršava 50–200 mutacija u nizu bez throttling-a. RLS svejedno svaku proveri, ali nema rate-limit-a. |

---

## 5. Prilagođena RBAC matrica (post-Faza-1)

| Akcija | viewer | hr | menadzment | pm | leadpm | admin |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Čita Plan Montaže | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Edituje Plan Montaže (svoj projekat) | ❌ | ❌ | ✅ | ✅* | ✅ | ✅ |
| Edituje Plan Montaže (sve projekte) | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ |
| Čita Kadrovska osnovno | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Čita Kadrovska sensitive (JMBG, banka) | ❌ | ✅ | ❌ | ❌ | ❌ | ✅ |
| Edituje Kadrovska | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ |
| Čita `audit_log` | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Manage `user_roles` | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Hard-delete mašina | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ |

*pm može da edituje samo projekte gde ima per-project `pm`/`leadpm` rolu u `user_roles`.

**Izvor:** `sql/migrations/add_menadzment_full_edit_kadrovska.sql`, `add_kadr_employee_extended.sql`, `enable_user_roles_rls_proper.sql`, `add_maint_machine_hard_delete.sql`, `add_audit_log.sql`. Kompletan generisani opis politika: `docs/SUPABASE_PUBLIC_SCHEMA.md`.

---

## 6. Šta NIJE u Fazi 1 (i zašto)

### 6.1 Ide u Fazu 2 (pre prvog enterprise klijenta)

1. **`SELECT USING(true)` čišćenje** na `sastanci_*` tabelama → suziti na učesnike + admin/menadzment.
2. **Webhook signature** za Edge Functions umesto `--no-verify-jwt`.
3. **Service-role atribucija u audit log-u** — `SET LOCAL audit.actor_email` u workerima pa modifikovati `audit_row_change()`.
4. **pgTAP security test suite:**
   - cross-user IDOR (user A pokušava UPDATE na resource user B)
   - privilege escalation (viewer pokušava INSERT u user_roles)
   - HR sensitive data masking (non-HR pokušava SELECT JMBG)
   - audit log immutability (ne-admin pokušava DELETE)
5. **Frontend route guard za Plan Montaže** u `src/ui/router.js` (sad samo Kadrovska/Podešavanja imaju `assertModuleAllowed`).
6. **Auto-generator RBAC matrice** iz `pg_policies` u Markdown.
7. **Rate limiting** na bulk import-e (Lokacije CSV, Kadrovska grid mass-edit).

### 6.2 Ide u Fazu 3 (maturity)

1. **Penetration testing** od strane treće strane.
2. **SOC 2 Type I priprema** (logging, change management procedure).
3. **Secret rotation** plan (anon key, service_role key).
4. **Backup encryption + restore drill** (Supabase ima ovo, ali nismo testirali restore).

### 6.3 Namerno NE radimo

- **Multi-tenancy refaktor** — `STRATEGIJA_ERP.md` §3.1 je eksplicitan: single-tenant do prve realne potrebe (drugi klijent). Refaktor sada bi koštao 6+ meseci za 0 vrednosti. Ako se javi drugi klijent, to ide u nov repo (`servoteh-erp`) sa modernim stack-om gde je tenant-id arhitektonski first-class građanin od početka.

---

## 7. Kako pokrenuti security checks lokalno

```bash
# 1. Schema baseline (4 zabranjena pattern-a)
npm run check:schema-baseline

# 2. Vitest suite (uključuje testove same baseline skripte)
npm test

# 3. Manuelna provera grant-a na osetljivim view-ima (nakon Supabase deploy-a)
psql "$SUPABASE_DB_URL" -c "
  SELECT grantee, privilege_type
  FROM   information_schema.role_table_grants
  WHERE  table_schema = 'public'
    AND  table_name IN ('v_production_operations', 'v_employees_safe')
  ORDER  BY table_name, grantee, privilege_type;"
# Očekivano: NEMA reda sa grantee='anon'.
```

CI radi `schema-baseline` job na svakom push/PR-u u `main`. Pad → blokira merge.

---

## 8. Kontakt i eskalacija

- Bezbednosni problem u kodu → otvoriti privatni issue na repo-u sa label-om `security`.
- Svaki novi `GRANT ... TO anon` mora kroz code review.
- Svaka nova Edge Function bez JWT verifikacije mora imati zapis ovde u §6.1 sa razlogom.

---

## 9. Istorijat verzija

| Verzija | Datum | Šta je urađeno | Ko |
|---|---|---|---|
| 1.0 | 2026-04-23 | Faza 1 hardening: offline mode gate, anon REVOKE, schema.sql usklađivanje, CI baseline guard | Nenad + AI |

---

> **Sledeći pregled:** posle Faze 2 (planirano: pre prvog enterprise klijenta).
