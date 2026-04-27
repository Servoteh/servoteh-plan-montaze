# CMMS — Automation i notifikacije (roadmap)

Ovaj dokument planira sledeći tehnički sloj posle stabilnog pilota.

## 1. Dnevni snapshot operacija (već u bazi)

View `public.v_maint_cmms_daily_summary` (migracija `add_maint_daily_ops_view.sql`) agregira za trenutnog korisnika (RLS):

- broj aktivnih radnih naloga
- otvoreni incidenti
- otvoreni kritični incidenti
- kasni preventivni rokovi
- delovi ispod minimalne zalihe

**Sledeći korak u UI:** kartice na dashboardu koje čitaju ovaj view preko PostgREST (`/rest/v1/v_maint_cmms_daily_summary?limit=1`).

## 2. Automatsko kreiranje WO za preventivu (cron)

Ručna akcija `Kreiraj WO` već postoji. Za potpuno automatsko kreiranje bez korisnika potrebno je:

- identitet za `reported_by` na WO (npr. servisni nalog `auth.users` ili posebno polje u `maint_settings`), ili
- Edge Function sa `service_role` koja poziva internu migracionu funkciju.

**Preporuka:** prvo pilot sa ručnim `Kreiraj WO`, pa odluka da li firma želi noćni batch.

Ako se koristi **pg_cron** (Supabase paid / self-hosted), prati isti obrazac kao u [`sql/migrations/add_kadr_notifications.sql`](../sql/migrations/add_kadr_notifications.sql):

```sql
-- Pseudokod: samo ako postoji pg_cron
-- SELECT cron.schedule('maint_preventive_daily', '0 6 * * *', $$ SELECT public.maint_...batch...() $$);
```

Implementacija batch funkcije treba da bude idempotentna (bez duplikata WO po `source_preventive_task_id`).

## 3. Kanali van aplikacije (email / WhatsApp / Telegram)

Trenutno se redovi queue-uju u `maint_notification_log`. Za stvarno slanje:

- worker (Edge Function, n8n, ili postojeći dispatch RPC) čita `queued` redove
- razrešava `recipient` po `target_role` iz payload-a pravila
- šalje preko izabranog provajdera

**Checklist pre produkcije:** SPF/DKIM za email, WhatsApp Business API odobrenje, Telegram bot token u Secrets.

## 4. Dashboard „šta danas“

Predložene kartice:

- P1/P2 otvoreni WO
- WO sa `due_at` u prošlosti
- Preventiva danas / ove nedelje
- Delovi ispod `min_stock`

Izvor podataka: kombinacija `v_maint_cmms_daily_summary` i postojećih upita u [`src/ui/odrzavanjeMasina/index.js`](../src/ui/odrzavanjeMasina/index.js) (KPI).

## 5. Zaključavanje WO (proces)

Dogovor sa šefom održavanja:

- obavezan komentar pri zatvaranju
- obavezni sati ako je WO duži od X sati
- obavezna lista delova za WO tipa `incident` sa severity `critical`

Te poslovne validacije mogu ići u trigger `BEFORE UPDATE` na `maint_work_orders` kada `status` prelazi u `zavrsen`.
