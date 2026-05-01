# PB Sprint 3 — analiza (pre implementacije)

## A1. `sql/migrations/add_pb_module.sql`

- **`pb_work_reports` kolone:** `id`, `employee_id`, `datum`, `sati`, `opis`, `created_at`, `created_by` — potvrđeno.
- **RLS:** već `ENABLE ROW LEVEL SECURITY` sa politikama: SELECT svi authenticated, INSERT/UPDATE `pb_can_edit_tasks()`, DELETE samo admin.
- **Audit:** trigger `trg_audit_pb_work_reports` ako postoji `audit_row_change()`.

**PB3:** Menjamo samo DELETE (i opciono UPDATE) politike za brisanje po `created_by` / admin — ostatak ostaje; `pb_tasks` RLS se ne dira.

## A2. Notifikacije (uzorci)

- **`add_kadr_notifications.sql`:** outbox sa status flow; `kadr_dispatch_dequeue` batch + mark sent/failed; config singleton; `pg_cron` u komentaru (07:00).
- **`hr-notify-dispatch`:** `fetch` na `/rest/v1/rpc/*` sa **service_role** JWT u `Authorization` + `apikey`; Resend ako je `RESEND_API_KEY`; DRY-RUN bez ključa.
- **X-Audit-Actor:** u HR Edge funkciji nije eksplicitno parsiran u uzorku; PB3 dodaje log u `console.log` za audit trail poziva.
- **Infrastruktura:** modulski Edge worker + odvojeni RPC-ovi (nema jedinstvenog zajedničkog dispatch-a za sve module).

## A3. `planTab.js` — alarmi

- **`buildAlarms(tasks, loadRows)`** vraća niz `{ level: 'red'|'yellow', text: string }`.
- Render: `pb-alarm-box` sa `pb-alarm pb-alarm--{level}`.

PB3 ne menja Plan tab; outbox emailovi paralelno šalju obaveštenja.

## A4. pg_cron

U ovom repou **nema** izlaza `SELECT jobname, schedule FROM cron.job` (Supabase SQL Editor — nije pokretano u CI). Migracija koristi `cron.schedule` uz komentar da se na projektu proveri duplikat pre primene.

## A5. Resend

- Edge funkcije koriste **`RESEND_API_KEY`** i **`RESEND_FROM`** iz secrets (vidi `hr-notify-dispatch`).
- PB3: ista konvencija; **ne hardcode** primalaca — samo `pb_notification_config.email_recipients` u enqueue SQL-u.
