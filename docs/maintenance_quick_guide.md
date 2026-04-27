# CMMS Kratko Uputstvo

**Produkcioni uvod:** detaljan checklist — [`CMMS_GO_LIVE_CHECKLIST.md`](CMMS_GO_LIVE_CHECKLIST.md) · pilot — [`CMMS_PILOT.md`](CMMS_PILOT.md) · šablon povratnih informacija — [`CMMS_PILOT_FEEDBACK.md`](CMMS_PILOT_FEEDBACK.md) · automatizacija — [`CMMS_AUTOMATION_ROADMAP.md`](CMMS_AUTOMATION_ROADMAP.md) · SQL seed šabloni — [`sql/seeds/README.md`](../sql/seeds/README.md).

## Osnovni Tok

1. Operator prijavljuje kvar iz modula `Održavanje` ili sa detalja mašine/sredstva.
2. Za `major`, `critical` ili safety marker incident sistem automatski kreira radni nalog prema `maint_settings`.
3. Tehničar ili šef održavanja preuzima radni nalog, menja status, dodaje delove, sate rada i dokumenta.
4. Preventivni rokovi se prate u `Preventiva` i po potrebi se akcijom `Kreiraj WO` pretvaraju u radni nalog.
5. Izveštaji prikazuju incidente, downtime, aktivne WO, trošak delova i radne sate, uz CSV export.

## Uloge

- `operator`: prijava kvara i pregled svojih/vidljivih sredstava.
- `technician`: rad na nalozima, unos delova, sati, dokumenata i preventivni WO.
- `chief`: upravljanje nalozima, katalozima, pravilima notifikacija i podešavanjima.
- `admin` i ERP menadžment: puni nadzor, podešavanja i produkciona kontrola.

## Produkcioni Smoke

Proveriti rute:

- `/maintenance`
- `/maintenance/work-orders`
- `/maintenance/assets`
- `/maintenance/assets/vehicles`
- `/maintenance/assets/it`
- `/maintenance/assets/facilities`
- `/maintenance/preventive`
- `/maintenance/inventory`
- `/maintenance/documents`
- `/maintenance/reports`
- `/maintenance/settings`

Minimalni test u radu:

- Kreirati test major incident i proveriti automatski WO, `due_at` i queued notifikacije.
- Otvoriti WO, promeniti status, dodati deo, sate i dokument.
- U preventivi kliknuti `Kreiraj WO` za jedan aktivan rok i proveriti da ne pravi duplikat.
- Izvesti standardni CSV i CSV troškova iz `Izveštaji`.
