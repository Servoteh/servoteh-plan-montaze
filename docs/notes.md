# Plan Montaze v5.1.1

Pilot hardening patch za online Supabase test.

## Promene

- Lowercase email role lookup u `index.html`
- Login i session restore normalizuju `currentUser.email` na lowercase
- `user_roles` dobija partial unique indekse preko `lower(email)`
- `has_edit_role()` i RLS su uskladjeni sa `user_roles`, bez oslanjanja na JWT role claim
- `sql/schema.sql` je uskladjen sa aktuelnom v5.1 semom
- Repo cleanup: uklonjeni probni i duplikat fajlovi

## Status

Spremno za pilot Supabase test i GitHub verzionisanje.

## Održavanje mašina — notifikacije (plan)

- Telegram integracija je PAUZIRANA odlukom korisnika (25.04.2026).
- Sledeći kanal: **WhatsApp Business Cloud API** (Meta).
- Priprema u bazi: `add_maint_notifications_plan.sql` dodaje `whatsapp` u
  `maint_notification_channel` enum, bez promene šeme.
- Preduslovi pre implementacije:
  - Verifikovan Meta Business nalog + WhatsApp Business broj.
  - Template poruke (Meta odobrenje, npr. "incident_alert_sr").
  - Supabase secrets: `WA_ACCESS_TOKEN`, `WA_PHONE_NUMBER_ID`,
    `WA_TEMPLATE_NAME`, `WA_TEMPLATE_LANG`.
- Plan implementacije (kada krenemo):
  1. `maint_user_profiles.phone` kolona (E.164 format) + UI polje u
     „Održ. profili”. **Dodato u `add_maint_notification_outbox.sql`.**
  2. Outbox infrastruktura na `maint_notification_log`
     (`scheduled_at`, `next_attempt_at`, `last_attempt_at`, `attempts`, `payload`)
     + AFTER INSERT trigger na `maint_incidents` (severity major/critical →
     stub queued red sa `recipient = 'pending'`). **Dodato u
     `add_maint_notification_outbox.sql`.**
  3. Edge Function `maint-notify-dispatch` (Deno) — **Skelet spreman u
     `supabase/functions/maint-notify-dispatch/`**:
     - Pokreće ga Supabase Scheduled Trigger (npr. svakog minuta).
     - Koristi SECURITY DEFINER RPC-ove iz
       `add_maint_notify_dispatch_rpc.sql`:
       `maint_dispatch_dequeue` (batch sa `FOR UPDATE SKIP LOCKED`),
       `maint_dispatch_fanout` (stub → child redovi po ulogama iz
       `maint_user_profiles`), `maint_dispatch_mark_sent`,
       `maint_dispatch_mark_failed` (backoff).
     - Bez `WA_*` Secrets-a radi u **DRY-RUN** režimu (console.log + mark
       sent), kad se postavi `WA_ACCESS_TOKEN` + `WA_PHONE_NUMBER_ID` +
       `WA_TEMPLATE_NAME` kreće pravo slanje preko
       `graph.facebook.com/v20.0/{phone_number_id}/messages` (template payload
       sa parametrima {{1}}=subject, {{2}}=body).
     - Detalji: `supabase/functions/maint-notify-dispatch/README.md`.
  4. Dnevni cron (pg_cron → webhook) za prekoračene kontrole
     (`v_maint_task_due_dates where next_due_at < now()`).
  5. Retry politika: posle N pokušaja `status = 'failed'` ostaje trajno (bez
     novog `next_attempt_at`); admin može ručno vratiti red u `'queued'`.
  6. UI „Obaveštenja” (`/maintenance/notifications`) — tab u Održavanju koji
     listuje `maint_notification_log` (RLS: chief/management/admin ili ERP
     admin). Filteri: status (queued/sent/failed/all) + šifra mašine. Prikazuje
     kanal, primaoca (ili `pending (fanout)` stub), severity iz
     `payload.severity`, naslov, error, `last/next_attempt_at` i broj pokušaja.
     Dugme „Retry” (chief/admin) zove RPC `maint_notification_retry(id)`
     koji postavi `status='queued'`, `error=NULL`, `next_attempt_at=now()`,
     `attempts=LEAST(attempts, max_attempts-1)`. Migracija:
     `sql/migrations/add_maint_notification_retry.sql`.

## Održavanje — katalog mašina (`maint_machines`)

- **Svrha**: modul Održavanje više ne zavisi od BigTehn sync-a. `maint_machines`
  je autoritativni izvor (name, type, manufacturer, model, serial, godine,
  lokacija, snaga, težina, napomene).
- **Šifra** (`machine_code`) je PK i **promenljiva preko RPC-a**. Iako ne
  postoji PostgreSQL FK (jer BigTehn cache ide briši-i-puni režimom), RPC
  `maint_machine_rename(old, new)` atomski menja šifru u svim `maint_*`
  tabelama:
    - maint_machines (insert novog reda + delete starog — da ne pokvari PK),
    - maint_tasks, maint_checks, maint_incidents, maint_machine_notes,
      maint_machine_status_override, maint_notification_log.
  Vraća JSONB sa brojem ažuriranih redova po tabeli. Dozvola: chief/admin
  maint ili ERP admin. Dugme „Promeni šifru…” je u edit modal-u katalog taba.
  Migracija: `sql/migrations/add_maint_machine_rename_rpc.sql`.
- **Soft delete**: `archived_at` + `tracked=false`. Arhivirana mašina:
  - nestaje iz `v_maint_machine_current_status` (i iz Mašina/Dashboard/Rokovi),
  - ali istorija incidenata/napomena/taskova **ostaje** u bazi,
  - detalj (`/maintenance/machines/<kod>`) i dalje otvoren u read-only modu sa
    crvenim bannerom „Arhivirana” (za proveru istorijskih podataka).
- **Seed**: migracija inicijalno uvozi sve `no_procedure=false` redove iz
  `bigtehn_machines_cache` (`source='bigtehn'`). Dalji sync **ne briše i ne
  menja** postojeće redove — BigTehn kvari naše metapodatke.
- **Ručno dodavanje** (npr. kompresor, HVAC van BigTehn-a): dugme „+ Dodaj
  mašinu” u tabu „Katalog” (chief/admin). `source='manual'`.
- **Uvoz novih mašina iz BigTehn-a**: posle sync-a se u `v_maint_machines_importable`
  pojave šifre koje nisu u katalogu. Dialog „Uvezi iz BigTehn-a” prikazuje
  listu i zove RPC `maint_machines_import_from_cache(codes TEXT[])`.
- **RLS**: SELECT — `maint_has_floor_read_access`; INSERT/UPDATE/DELETE —
  chief/admin maint ili ERP admin.
- **Migracija**: `sql/migrations/add_maint_machines_catalog.sql`.
- **UI fajlovi**: `src/ui/odrzavanjeMasina/maintCatalogTab.js` (tabela + edit
  modal + import dialog). Subnav stavka „Katalog” u Održavanju.
- **Uredi mašinu iz detalja**: dugme „Uredi mašinu” je u zaglavlju
  `/maintenance/machines/<kod>` (chief/admin). Otvara isti modal iz kataloga.

## Održavanje — dokumenti uz mašinu (`maint_machine_files`)

- **Svrha**: uputstva (PDF), fotografije, tehnički crteži, servisni
  izveštaji, garantni listovi, računi — sve vezano za konkretnu mašinu.
- **Šema**:
  - `maint_machine_files` (id uuid, `machine_code`, `file_name`,
    `storage_path` UNIQUE, mime/size, `category`, `description`,
    `uploaded_at/by`, `deleted_at`).
  - Index po `(machine_code, uploaded_at DESC) WHERE deleted_at IS NULL`.
  - Kategorije (UI autocomplete): manual, photo, drawing, service_report,
    warranty, invoice, other.
- **Storage**: privatan bucket `maint-machine-files`, 25 MB po fajlu,
  dozvoljeni MIME: PDF, slike (JPEG/PNG/WebP/GIF), Word, Excel, CSV, TXT.
  Putanja: `<machine_code>/<uuid>_<safeName>`.
- **RLS**:
  - SELECT (tabela + storage): `maint_has_floor_read_access`.
  - INSERT: operator/technician/chief/admin (ili ERP admin), `uploaded_by=auth.uid()`.
  - UPDATE/DELETE (tabela): chief/admin uvek; autor do 24h ako je
    operator/tehničar.
  - DELETE (storage object): chief/admin ili `owner=auth.uid()`.
- **Brisanje**: soft-delete reda (`deleted_at`) + best-effort DELETE objekta u
  Storage-u. Ako Storage delete ne uspe (mreža/RLS), metadata je već sakriven
  od UI-a preko `deleted_at IS NULL` filtera.
- **Download**: aplikacija nikad ne deli javne linkove. UI traži
  `signedURL` (TTL 300 s) preko `/storage/v1/object/sign/…` i otvara u novom
  tabu.
- **UI**: tab „Dokumenti” u detalju mašine (`/maintenance/machines/<kod>?tab=dokumenti`).
  Fajl: `src/ui/odrzavanjeMasina/maintFilesTab.js`.
- **Migracija**: `sql/migrations/add_maint_machine_files.sql`.

