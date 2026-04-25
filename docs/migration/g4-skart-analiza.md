# G4 skart/dorada analiza - faza A

## Cilj

Utvrditi kako u BigTehn/Supabase cache sloju prepoznati pozicije koje su pustene kao dorada ili skart, pre bilo kakve implementacije UI badge-a i filtera u modulu Planiranje proizvodnje.

## Izvori koje sam proverio

- `docs/bridge/01-current-state.md` navodi da je `dbo.tStavkeRN` definisana oko `script.sql:1922`, a `dbo.tTehPostupak` oko `script.sql:1849`.
- `docs/QMegaTeh_Dokumentacija.md` opisuje kontrolu kvaliteta: `tRN.IDVrstaKvaliteta` u odnosu na kvalitet kontrole (`000_ProveraSkartova`) i glossary vrednosti `Skart` / `Dorada`.
- `C:\Users\nenad.jarakovic\Desktop\BigbitRaznoNenad\script.sql` sadrzi direktne definicije:
  - `tTehPostupak` na `script.sql:1849-1870`
  - `tStavkeRN` na `script.sql:1922-1935`
  - `ftZavrseniPostupciPreDoradeIliSkarta` na `script.sql:4193-4240`
  - `ftDodatiPostupkeZaDoraduIliSkart` na `script.sql:4257-4303`
- `docs/SUPABASE_PUBLIC_SCHEMA.md` pokazuje trenutne cache kolone:
  - `bigtehn_work_order_lines_cache`: nema `quality_type_id`, `dorada_operacije`, `skart`, niti vezu ka originalnoj doradi.
  - `bigtehn_tech_routing_cache`: ima `quality_type_id` i `dorada_operacije`.
  - `bigtehn_part_movements_cache`: ima `quality_type_id` i `kolicina`.
  - `bigtehn_quality_types_cache`: master vrednosti kvaliteta.
- `workers/loc-sync-mssql/scripts/backfill-production-cache.js` trenutno mapira:
  - `dbo.tStavkeRN` -> `bigtehn_work_order_lines_cache`, ali ne povlaci `DoradaOperacije`.
  - `dbo.tTehPostupak.DoradaOperacije` -> `bigtehn_tech_routing_cache.dorada_operacije`.

## BigTehn definicije relevantne za doradu/skart

### `tTehPostupak`

`script.sql:1849-1870` pokazuje da izvrseni postupak ima:

- `IDPostupka` kao PK
- `IDPredmet`, `IdentBroj`, `Varijanta`, `Operacija`, `RJgrupaRC`
- `Komada`
- `IDRN`
- `IDVrstaKvaliteta`
- `DoradaOperacije`

`DoradaOperacije` ima default 0 (`script.sql:8055-8057`).

### `tStavkeRN`

`script.sql:1922-1935` pokazuje da planirana stavka RN-a ima:

- `IDStavkeRN` kao PK
- `IDRN`, `Operacija`, `RJgrupaRC`, `OpisRada`
- `Tpz`, `Tk`, `TezinaTO`
- `Prioritet`

Nema `IDVrstaKvaliteta`, `DoradaOperacije`, niti direktan marker da je planirana stavka nastala zbog dorade/skarta.

### `ftZavrseniPostupciPreDoradeIliSkarta`

`script.sql:4203-4239`:

- Cita `tTehPostupak`.
- Grupise po `IDPredmet`, `IdentBroj`, `Varijanta`, `Operacija`.
- Vraca `SUM(tp.Komada) AS UkupnoKomada`, `COUNT(tp.IDPostupka) AS BrojUnosa`, `MAX(tp.DatumIVremeUnosa) AS datum`.
- Filtrira ranije operacije: `tp.Operacija < ISNULL(@ZaOperaciju,1000)`.
- Parametar `@ZaDoraduOperacije` postoji, ali uslov nad `tp.ZavrsenPostupak = ISNULL(@ZaDoraduOperacije,tp.Operacija)` je zakomentarisan.

Ova funkcija je vise "sta je zavrseno pre odluke o doradi/skartu" nego direktan marker planirane doradne stavke.

### `ftDodatiPostupkeZaDoraduIliSkart`

`script.sql:4267-4303`:

- Cita `tRN INNER JOIN tStavkeRN`.
- Vraca `tRN.IDRN`, `IDPredmet`, `IdentBroj`, `Varijanta`, `PrnTimer`, `GETDATE()`, `tStavkeRN.Operacija`, `tStavkeRN.RJgrupaRC`, `0 AS tOznaka`.
- Filtrira sledece operacije: `Operacija > ISNULL(@ZaOperaciju,0)`.
- Komentarisani su parametri `@Kontrolor` i `@KomadaDoradeIliSkarta`, kao i izlaz `@KomadaDoradeIliSkarta AS Komada`.

Ova funkcija daje predlog koje naredne operacije treba dodati za doradu/skart, ali ne vraca `IDStavkeRN` niti status `DORADA/ŠKART`. Status i broj komada dolaze iz spoljnog konteksta poziva.

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

### A) Prosiriti sync nad `tTehPostupak`

Pros:
- Koristi vec postojeci BigTehn signal: `IDVrstaKvaliteta` i `DoradaOperacije`.
- Ne zavisi od teksta operacije.
- Moze jasno da razlikuje `DORADA` i `ŠKART` u izvrsenim postupcima.

Cons:
- Daje signal nad izvrsenjem (`tTehPostupak`), ne nad planiranom stavkom (`tStavkeRN`).
- U trenutnim podacima `DoradaOperacije` je 0 za sve cache redove, pa ga treba proveriti na nivou procesa unosa.
- Ne daje direktno `line_id` (`IDStavkeRN`), samo `work_order_id + operacija`.

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
- Zahteva worker/sync doradu.
- Mora se definisati natural key jer `ftDodatiPostupkeZaDoraduIliSkart` ne vraca poseban ID reda dorade/skarta.

## Preporuka

Ne implementirati G4 fazu B na osnovu heuristike.

Preporucujem opciju C, sada sa poznatim BigTehn funkcijama:

1. U bridge sync dodati novu cache tabelu, npr. `bigtehn_rework_scrap_cache`.
2. Puniti je iz kombinacije:
   - `tTehPostupak` redova gde je `IDVrstaKvaliteta IN (1,2)` za stvarni kvalitet i broj komada,
   - logike `ftZavrseniPostupciPreDoradeIliSkarta` / `ftDodatiPostupkeZaDoraduIliSkart` za povezivanje prethodne/naredne operacije.
3. Natural key za prvi prolaz moze biti `(work_order_id, ident_broj, varijanta, source_operacija, target_operacija, quality_type_id)`, uz oprez jer nema eksplicitnog source ID-a za "odluku".
4. U `v_production_operations` dodati `is_rework`, `is_scrap`, `rework_pieces`, `scrap_pieces` kroz join po `work_order_id + operacija`.
5. Tek onda dodati UI badge/filter.

Privremeno, ako je potreban brz vizuelni indikator pre punog sync-a, moze se dodati samo "tekstualni hint" za `opis_rada ILIKE '%dorad%'`, ali ga ne bih nazivao sistemskim skart/dorada statusom.

## Otvorena pitanja za potvrdu

- Da li je poslovno dovoljno da se badge prikaze na narednoj operaciji iz `ftDodatiPostupkeZaDoraduIliSkart`, ili mora postojati poseban "odluka o doradi/skartu" red?
- Da li poslovno treba prikazati samo sistemski nastale dorade/skart, ili i operacije ciji opis rucno sadrzi "DORADA"?
- Da li UI treba da prikazuje broj komada za doradu/skart po operaciji ili samo badge na RN/operaciji?
