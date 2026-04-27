# CMMS — Go-live checklist

Koristi ovaj dokument pred puštanje u realan rad i označi stavke kada su proverene.

## 1. Build i CI (lokalno ili u pipeline-u)

- [ ] `npm test` — svi testovi prolaze
- [ ] `npm run check:rbac-matrix` — matrica u skladu sa migracijama
- [ ] `npm run build` — produkcioni bundle bez greške

## 2. Baza — migracije primenjene na live

Redosled za CMMS deo je u [`sql/ci/migrations.txt`](../sql/ci/migrations.txt) (od `add_maintenance_module.sql` pa nadalje, uključujući `integrate_maint_settings_behavior.sql` i `add_maint_preventive_auto_wo.sql`).

- [ ] Na Supabase primenjene sve relevantne migracije (Dashboard / CLI / MCP)
- [ ] Postoji red u `public.maint_settings` (`id = 1`)
- [ ] Postoji tabela `public.maint_notification_rules` i bar default pravila (nakon integracije)

Opcioni SQL smoke (izvršiti u SQL editoru kao admin):

```sql
select id from public.maint_settings where id = 1;
select count(*) as rules from public.maint_notification_rules;
select to_regprocedure('public.maint_create_preventive_work_order(uuid)') as preventive_rpc;
```

## 3. Aplikacija — rute (ručno u browseru nakon deploy-a)

Otvori svaku rutu ulogovan kao korisnik sa ulogom održavanja (npr. `technician` ili `chief`):

- [ ] `/maintenance`
- [ ] `/maintenance/work-orders`
- [ ] `/maintenance/assets`
- [ ] `/maintenance/assets/vehicles`
- [ ] `/maintenance/assets/it`
- [ ] `/maintenance/assets/facilities`
- [ ] `/maintenance/preventive`
- [ ] `/maintenance/calendar`
- [ ] `/maintenance/inventory`
- [ ] `/maintenance/documents`
- [ ] `/maintenance/reports`
- [ ] `/maintenance/settings`

## 4. End-to-end tok (jedan scenario)

- [ ] Prijava **major** ili **critical** incidenta → proveri automatski radni nalog, `due_at` i notifikacije u `maint_notification_log` (ako koristiš outbox)
- [ ] Otvaranje WO iz liste/kanbana → promena statusa / dodele
- [ ] Unos dela i sati na WO
- [ ] Upload dokumenta na WO (tab Dokumenta)
- [ ] U **Preventiva** → **Kreiraj WO** za jedan rok → drugi klik ne sme duplirati aktivan WO
- [ ] **Izveštaji** → Export CSV i **Troškovi CSV**

## 5. Uloge i RLS

Za svaku ulogu (`operator`, `technician`, `chief`, `admin`, `management`) kratko proveri:

- [ ] Vidi očekivane mašine/sredstva i incidente
- [ ] Može / ne može da menja podešavanja i pravila eskalacije prema očekivanju

Detaljnije: [`docs/CMMS_PILOT.md`](CMMS_PILOT.md).

## 6. Posle go-live

- [ ] Zakazati pilot nedelju (vidi [`docs/CMMS_PILOT.md`](CMMS_PILOT.md))
- [ ] Prikupljati feedback preko [`docs/CMMS_PILOT_FEEDBACK.md`](CMMS_PILOT_FEEDBACK.md)
- [ ] Sledeća tehnička faza: [`docs/CMMS_AUTOMATION_ROADMAP.md`](CMMS_AUTOMATION_ROADMAP.md)
