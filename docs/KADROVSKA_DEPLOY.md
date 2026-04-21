# KADROVSKA — Deploy vodič (Faza K2 / K3 / K3.2 / K4)

Ovaj dokument je kompletan checklist za deploy svih faza proširenja
modula Kadrovska. Prati korake redom.

---

## 📋 Šta je urađeno

**Faza K2 — Zaposleni proširen + Godišnji odmor**

- Proširena tabela `employees` (JMBG, adresa, banka, krsna slava, lekarski…)
- Deca zaposlenog (nova tabela `employee_children`)
- Godišnji odmor (nova tabela `vacation_entitlements` + view `v_vacation_balance`)
- Tab „Godišnji odmor" + Rešenje (HTML print template)
- Novi izveštaji: demografija / saldo GO / deca

**Faza K3 — Zarade — uslovi (strogo admin)**

- Tabela `salary_terms` (ugovor / dogovor / satnica, istorijski zapisi)
- View `v_employee_current_salary`
- RLS: SELECT/INSERT/UPDATE/DELETE — samo `admin`
- Tab „Zarade" (samo admin vidi)

**Faza K3.2 — Zarade — mesečni obračun (strogo admin)**

- Proširena tabela `salary_terms` sa `transport_allowance_rsd`, `per_diem_rsd`, `per_diem_eur`
- Nova tabela `salary_payroll` (jedan red po zaposlenom × mesecu)
- Ciklus: **I deo** (akontacija do 5.) + **II deo** (konačno 15–20.)
- Formula: `BAZA + prevoz + (dinarska × dom. tereni)`; devizne EUR zasebno
- RPC `kadr_payroll_init_month(y, m)` — auto-kreira draft redove sa snapshot-om uslova
- View `v_salary_payroll_month` (JOIN na employees)
- Sub-tabovi u „Zarade": **📜 Uslovi** / **🧾 Mesečni obračun**
- Excel export po mesecu

**Faza K4 — Notifikacije (WhatsApp + email)**

- Tabele `kadr_notification_config` (singleton) + `kadr_notification_log` (outbox)
- Funkcije `kadr_schedule_hr_reminders()`, dispatch RPC-ovi
- Alert tipovi: lekarski ističe, ugovor ističe, rođendan, godišnjica rada
- Edge funkcija `hr-notify-dispatch` (WhatsApp Meta Cloud + Resend email)
- Tab „Notifikacije" — queue + settings modal

---

## 1️⃣ SQL migracije (Supabase SQL Editor)

Pokreni redom, jednu po jednu, svaka je idempotentna:

```
sql/migrations/add_kadr_employee_extended.sql        # K2 (ako nije već)
sql/migrations/add_kadr_salary_terms.sql             # K3
sql/migrations/add_kadr_salary_payroll.sql           # K3.2  ← NOVO
sql/migrations/add_kadr_notifications.sql            # K4
```

Ako neka migracija baci `Missing … first`, znači da nisi pokrenuo
prethodnu zavisnost (npr. `add_kadrovska_module.sql`, `add_admin_roles.sql`).

### Verifikacija u SQL editoru

```sql
-- K3:
SELECT count(*) FROM salary_terms;
SELECT * FROM v_employee_current_salary LIMIT 3;

-- K3.2:
SELECT count(*) FROM salary_payroll;
SELECT * FROM v_salary_payroll_month LIMIT 3;
-- Dry-run init meseca (samo admin nalog sme):
-- SELECT kadr_payroll_init_month(2026, 4);

-- K4:
SELECT * FROM kadr_notification_config;                  -- treba 1 red (id=1)
SELECT count(*), status FROM kadr_notification_log GROUP BY status;
SELECT * FROM kadr_trigger_schedule_hr_reminders();      -- ručni test skeniranja

-- pg_cron (ako je dostupan):
SELECT jobname, schedule FROM cron.job WHERE jobname LIKE 'kadr_%';
```

---

## 2️⃣ pg_cron — dnevno skeniranje

Migracija `add_kadr_notifications.sql` već pokušava da registruje job
`kadr_schedule_hr_reminders_daily` na `0 7 * * *` (svaki dan u 07:00).

Ako pg_cron nije instaliran na tvom projektu (nema `cron` šeme), Supabase
ti ga može omogućiti kroz Dashboard → Database → Extensions → `pg_cron`.
Nakon aktivacije ponovi migraciju.

Alternativa (bez pg_cron-a): **Supabase Scheduled Triggers** (Dashboard →
Database → Cron Jobs) ili eksterni scheduler (GitHub Actions) koji svakih
24h poziva:

```sql
SELECT public.kadr_schedule_hr_reminders();
```

---

## 3️⃣ Edge Function — deploy

```bash
supabase functions deploy hr-notify-dispatch --no-verify-jwt
```

### Env Secrets (Dashboard → Edge Functions → hr-notify-dispatch → Secrets)

| Secret                 | Obavezno?          | Opis                                               |
| ---------------------- | ------------------ | -------------------------------------------------- |
| `WA_ACCESS_TOKEN`      | opciono            | Meta Cloud API token. Bez njega — DRY-RUN.         |
| `WA_PHONE_NUMBER_ID`   | opciono            | `phone_number_id` iz Meta Business Manager.       |
| `WA_TEMPLATE_NAME`     | opciono            | Npr. `hr_alert_sr` (approved template).            |
| `WA_TEMPLATE_LANG`     | opciono            | Default `sr`.                                       |
| `RESEND_API_KEY`       | opciono            | Za email kanal (resend.com). Bez njega — DRY-RUN.  |
| `RESEND_FROM`          | opciono            | Default `noreply@servoteh.rs`.                     |
| `HR_DISPATCH_BATCH`    | opciono            | Default `25`.                                       |

`SUPABASE_URL` i `SUPABASE_SERVICE_ROLE_KEY` su automatski dostupni.

### WhatsApp template (Meta Business Manager)

Template mora biti **approved** pre slanja. Preporučeno:

- **Name**: `hr_alert_sr`
- **Category**: `UTILITY`
- **Language**: `Serbian (sr)`
- **Body**:

    ```
    {{1}}
    {{2}}
    ```

Parametar `{{1}}` = subject, `{{2}}` = body (šalje edge funkcija automatski).

### Dispatch cron (Supabase Dashboard → Database → Cron Jobs)

Kreiraj novi job koji svakih 5 minuta poziva funkciju:

- **Name**: `hr_dispatch_tick`
- **Schedule**: `*/5 * * * *`
- **SQL**:

    ```sql
    SELECT net.http_post(
      url     := 'https://<YOUR_PROJECT>.supabase.co/functions/v1/hr-notify-dispatch',
      headers := jsonb_build_object(
        'Authorization', 'Bearer <YOUR_SERVICE_ROLE_KEY>',
        'Content-Type',  'application/json'
      )
    );
    ```

Zameni `<YOUR_PROJECT>` i `<YOUR_SERVICE_ROLE_KEY>` realnim vrednostima iz
Dashboard → Project Settings → API.

---

## 4️⃣ Frontend — deploy (Cloudflare Pages / ili gde već)

```bash
npm ci
npm run build
```

Upload-uj `dist/` folder na hosting ili push u git ako je CI već setapiran.

---

## 5️⃣ Testiranje E2E

### K3 — Zarade (uslovi)

1. Uloguj se kao `admin`.
2. Kadrovska → tab **Zarade** → sub-tab **📜 Uslovi zarade** (vidljiv samo tebi; HR ga ne vidi).
3. `+ Novi unos zarade` → izaberi zaposlenog, tip `ugovor`, iznos `120000`,
   valuta `RSD`, „Važi od" = danas. U sekciji **Mesečni dodaci** unesi npr.
   `Prevoz = 5000`, `Dinarska dnev. = 2500`, `Devizna dnev. = 25`. Sačuvaj.
4. Za satničara — tip `satnica`, iznos npr. `450`, „Važi od" = danas.
5. Otvori **📜 Istorija** za istog zaposlenog → vidiš red.
6. Uloguj se kao `hr` korisnik — tab **Zarade** ne sme da se pojavi.

### K3.2 — Mesečni obračun

1. Kao `admin` → Kadrovska → **Zarade** → sub-tab **🧾 Mesečni obračun**.
2. Izaberi tekući mesec u picker-u → klikni **+ Pripremi mesec** →
   toast javlja koliko redova je kreirano (snapshot iz „Uslovi").
3. Za satničara: unesi **Sati** (npr. 168) i **I deo** (npr. 30000).
   Polja prevoz / domaći tereni / ino tereni zoveš po potrebi.
   Ukupno RSD, II deo i Ukupno EUR se računaju **live** pre čuvanja.
4. Klikni **💾 Sačuvaj** u redu → status ostaje `draft`.
5. Klikni **↑ Status** → prelazi u `I deo isplaćen`. Još jednom → `Finalizovano`.
   Konačno → `Isplaćeno` (red se zaključava, input-i postaju readonly).
6. Klikni **📊 Excel** → preuzmeš fajl `Zarade_obracun_YYYY-MM.xlsx` sa
   svim obračunima i sumarnim redom.
7. **Verifikacija formule** (SQL):

    ```sql
    SELECT employee_id, salary_type, hours_worked, hourly_rate, fixed_salary,
           transport_rsd, domestic_days, per_diem_rsd,
           foreign_days, per_diem_eur,
           total_rsd, total_eur, second_part_rsd, status
    FROM   v_salary_payroll_month
    WHERE  period_year = 2026 AND period_month = 4
    ORDER  BY employee_name;
    ```

### K4 — Notifikacije

1. Kao `admin` ili `hr` → Kadrovska → **Notifikacije**.
2. Klikni **⚙️ Podešavanja** → unesi bar jedan WhatsApp broj ili email →
   Sačuvaj.
3. Klikni **🔔 Skeniraj sada** → dobićeš toast sa brojem zakazanih alerta
   (deo zavisi od toga da li ima zaposlenih sa `medical_exam_expires` ili
   ugovora koji ističu u prozoru).
4. Ako si postavio WA env vars — proveri WhatsApp; ako ne — otvori Supabase
   Dashboard → Edge Functions → `hr-notify-dispatch` → Logs i uveri se da
   je poruka stigla do `[DRY-RUN whatsapp]` log linije.
5. Ručno test pozivom edge funkcije:

    ```bash
    curl -X POST "https://<PROJECT>.supabase.co/functions/v1/hr-notify-dispatch" \
         -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
    ```

---

## 6️⃣ Troubleshooting

### „Migracija add_kadr_notifications.sql nije primenjena" u UI-ju

Proveri postoji li funkcija:

```sql
SELECT 1 FROM pg_proc WHERE proname = 'kadr_trigger_schedule_hr_reminders';
```

Ako vraća 0 redova — ponovo pokreni migraciju.

### Zarade — „Čuvanje nije uspelo"

Proveri da je korisnik u tabeli `user_roles` sa rolom `admin`:

```sql
SELECT email, role FROM user_roles WHERE email = LOWER('tvoj@email.com');
```

### WhatsApp ne stiže

- Template mora biti **approved** u Meta Business Manager-u.
- Primalac mora prvi put da ti piše (opt-in) ili se šalje samo template
  poruka u `UTILITY` kategoriji (koja ne zahteva opt-in van 24h).
- Proveri Edge function logs za tačan 400/403 response.

### Red je u `failed` stanju

U UI-ju otvori failed tab → klik **♻ Retry**. Ili u SQL-u:

```sql
UPDATE kadr_notification_log
   SET status = 'queued', next_attempt_at = now(), error = NULL
 WHERE status = 'failed';
```

### pg_cron extension nije dostupan

Koristi Supabase Scheduled Triggers umesto toga, ili eksterni cron.

---

## 7️⃣ Rollback (ako nešto pukne)

```sql
-- K4 (notifikacije)
DROP FUNCTION IF EXISTS public.kadr_trigger_schedule_hr_reminders();
DROP FUNCTION IF EXISTS public.kadr_schedule_hr_reminders();
DROP FUNCTION IF EXISTS public.kadr_dispatch_dequeue(int,int);
DROP FUNCTION IF EXISTS public.kadr_dispatch_mark_sent(uuid[]);
DROP FUNCTION IF EXISTS public.kadr_dispatch_mark_failed(uuid,text,int);
DROP TABLE IF EXISTS public.kadr_notification_log;
DROP TABLE IF EXISTS public.kadr_notification_config;
-- pg_cron:
SELECT cron.unschedule('kadr_schedule_hr_reminders_daily');

-- K3.2 (mesečni obračun) — rollback PRE K3
DROP FUNCTION IF EXISTS public.kadr_payroll_init_month(int, int);
DROP VIEW IF EXISTS public.v_salary_payroll_month;
DROP TABLE IF EXISTS public.salary_payroll;
ALTER TABLE public.salary_terms
  DROP COLUMN IF EXISTS transport_allowance_rsd,
  DROP COLUMN IF EXISTS per_diem_rsd,
  DROP COLUMN IF EXISTS per_diem_eur;

-- K3 (zarade)
DROP VIEW IF EXISTS public.v_employee_current_salary;
DROP TABLE IF EXISTS public.salary_terms;

-- K2 (zaposleni proširen) — NE preporučujem rollback; samo uklonite
-- dodatne kolone ako stvarno morate (izgubićete podatke).
```

---

## 📎 Fajlovi

### Migracije

- `sql/migrations/add_kadr_employee_extended.sql` (K2)
- `sql/migrations/add_kadr_salary_terms.sql` (K3)
- `sql/migrations/add_kadr_salary_payroll.sql` (K3.2)  ← NOVO
- `sql/migrations/add_kadr_notifications.sql` (K4)

### Edge funkcija

- `supabase/functions/hr-notify-dispatch/index.ts`
- `supabase/functions/hr-notify-dispatch/README.md`

### Frontend (novi / ključno izmenjeni)

- `src/services/salary.js`
- `src/services/hrNotifications.js`
- `src/ui/kadrovska/salaryTab.js`
- `src/ui/kadrovska/hrNotificationsTab.js`
- `src/ui/kadrovska/vacationTab.js`
- `src/ui/kadrovska/reportsTab.js`
- `src/state/auth.js` (dodati `canAccessSalary`, `isHrOrAdmin`)
