# G4 skart/dorada analiza - faza A

## Cilj

Utvrditi kako u BigTehn/Supabase cache sloju prepoznati pozicije koje su pustene kao dorada ili skart, pre bilo kakve implementacije UI badge-a i filtera u modulu Planiranje proizvodnje.

## Izvori koje sam proverio

- `docs/bridge/01-current-state.md` navodi da je `dbo.tStavkeRN` definisana oko `script.sql:1922`, a `dbo.tTehPostupak` oko `script.sql:1849`.
- `docs/QMegaTeh_Dokumentacija.md` opisuje kontrolu kvaliteta: `tRN.IDVrstaKvaliteta` u odnosu na kvalitet kontrole (`000_ProveraSkartova`) i glossary vrednosti `Skart` / `Dorada`.
- `docs/SUPABASE_PUBLIC_SCHEMA.md` pokazuje trenutne cache kolone:
  - `bigtehn_work_order_lines_cache`: nema `quality_type_id`, `dorada_operacije`, `skart`, niti vezu ka originalnoj doradi.
  - `bigtehn_tech_routing_cache`: ima `quality_type_id` i `dorada_operacije`.
  - `bigtehn_part_movements_cache`: ima `quality_type_id` i `kolicina`.
  - `bigtehn_quality_types_cache`: master vrednosti kvaliteta.
- `workers/loc-sync-mssql/scripts/backfill-production-cache.js` trenutno mapira:
  - `dbo.tStavkeRN` -> `bigtehn_work_order_lines_cache`, ali ne povlaci `DoradaOperacije`.
  - `dbo.tTehPostupak.DoradaOperacije` -> `bigtehn_tech_routing_cache.dorada_operacije`.

Napomena: `script.sql` nije pronadjen u ovom repo-u niti u `Downloads`, pa direktne reference na `ftZavrseniPostupciPreDoradeIliSkarta` / `ftDodatiPostupkeZaDoraduIliSkart` nisu mogle biti citirane iz izvornog fajla.

## Ziva Supabase provera

Master kvalitet vrednosti:

| id | name |
|---:|---|
| 0 | DOBAR |
| 1 | DORADA |
| 2 | ŠKART |

Cache kolone za signal:

| tabela | relevantne kolone |
|---|---|
| `bigtehn_work_order_lines_cache` | `id`, `work_order_id`, `operacija`, `machine_code`, `opis_rada`, `prioritet` |
| `bigtehn_tech_routing_cache` | `work_order_id`, `operacija`, `quality_type_id`, `komada`, `dorada_operacije` |
| `bigtehn_part_movements_cache` | `work_order_id`, `quality_type_id`, `kolicina` |

Rezultati nad trenutnim podacima:

| provera | rezultat |
|---|---:|
| `bigtehn_tech_routing_cache.dorada_operacije <> 0` | 0 redova |
| `bigtehn_tech_routing_cache` sa kvalitetom `DORADA` | 5 redova / 9 komada |
| `bigtehn_tech_routing_cache` sa kvalitetom `ŠKART` | 42 reda / 1308 komada |
| `bigtehn_part_movements_cache` sa kvalitetom `ŠKART` | 10 redova / 11 komada |
| `bigtehn_work_order_lines_cache.opis_rada ILIKE '%dorad%'` | 959 redova |
| `bigtehn_work_order_lines_cache.opis_rada ILIKE '%skart%'` | 0 redova |

## Zakljucak

Trenutni `bigtehn_work_order_lines_cache` nije dovoljan da pouzdano oznaci planiranu operaciju kao doradu/skart. Postoje dva tipa signala, ali nijedan nije idealan za automatski badge nad planiranom operacijom:

- `quality_type_id` u `bigtehn_tech_routing_cache` i `bigtehn_part_movements_cache` pokazuje da se u izvrsenju/kretanju pojavio kvalitet `DORADA` ili `ŠKART`.
- Tekstualni `opis_rada` hvata mnogo dorada, ali je heuristika i ne razlikuje sistemski dodatu doradu od normalne operacije koja u opisu ima rec "dorada".

## Opcije

### A) Dodati source polje/vezu iz BigTehn-a u sync

Pros:
- Najpouzdanije za UI badge i filter.
- Ne zavisi od teksta operacije.
- Moze jasno da razlikuje `DORADA` i `ŠKART`, broj komada i eventualni izvorni postupak.

Cons:
- Trazi dodatnu MSSQL analizu kada `script.sql` bude dostupan.
- Verovatno trazi novu cache kolonu ili novu cache tabelu.

### B) Heuristika u Postgres view-u

Primeri:
- `opis_rada ILIKE '%dorad%'`
- join na `bigtehn_tech_routing_cache.quality_type_id IN (1,2)`
- visok `prioritet` ili ponovljena operacija

Pros:
- Brzo za UI prototip.
- Bez bridge sync izmena.

Cons:
- Rizik false positive/false negative je visok.
- U trenutnim podacima `prioritet = 255` ima skoro sve linije, pa nije koristan signal.
- `dorada_operacije` je trenutno uvek 0, pa ne pomaze.

### C) Dodati posebnu cache tabelu za doradu/skart

Pros:
- Cist model za Planiranje proizvodnje: `work_order_id`, `line_id/operacija`, `quality_type_id`, `rework_pieces/scrap_pieces`, `source_record_id`.
- UI badge i filter postaju jednostavni.
- Ne zagadjuje postojece cache tabele ako source logika dolazi iz posebnih funkcija/tabela.

Cons:
- Zahteva identifikaciju tacnog BigTehn izvora.
- Zahteva worker/sync doradu.

## Preporuka

Ne implementirati G4 fazu B na osnovu heuristike.

Preporucujem opciju C, uz prethodnu kratku MSSQL proveru kada bude dostupan `script.sql` ili direktan pristup izvornim objektima:

1. Naci tacne definicije `ftZavrseniPostupciPreDoradeIliSkarta` i `ftDodatiPostupkeZaDoraduIliSkart`.
2. Utvrditi da li postoji stabilan source ID za doradu/skart i kako se vezuje za `tStavkeRN.IDStavkeRN`, `IDRN`, `Operacija` i broj komada.
3. Dodati cache tabelu tipa `bigtehn_rework_scrap_cache`.
4. Tek onda u `v_production_operations` dodati `is_rework`, `is_scrap`, `rework_pieces`, `scrap_pieces` i UI badge/filter.

Privremeno, ako je potreban brz vizuelni indikator pre punog sync-a, moze se dodati samo "tekstualni hint" za `opis_rada ILIKE '%dorad%'`, ali ga ne bih nazivao sistemskim skart/dorada statusom.

## Otvorena pitanja za potvrdu

- Da li mozemo dobiti `script.sql` ili direktan export definicija za `ftZavrseniPostupciPreDoradeIliSkarta` i `ftDodatiPostupkeZaDoraduIliSkart`?
- Da li poslovno treba prikazati samo sistemski nastale dorade/skart, ili i operacije ciji opis rucno sadrzi "DORADA"?
- Da li UI treba da prikazuje broj komada za doradu/skart po operaciji ili samo badge na RN/operaciji?
