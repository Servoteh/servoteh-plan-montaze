# G7 Kooperacija — auto-grupe (Faza A)

Datum: 2026-04-25

## Cilj

Utvrditi koje BigTehn RJ vrednosti mogu bezbedno da budu seed za buduću
lookup tabelu `production_auto_cooperation_groups`.

Ova faza je samo analiza:

- nema SQL migracija,
- nema izmena u `src/`,
- nema izmene `v_production_operations`.

## Izvor podataka

Prema `docs/SUPABASE_PUBLIC_SCHEMA.md`, relevantne kolone su:

| tabela | kolona | značenje |
|---|---|---|
| `bigtehn_machines_cache` | `rj_code` | šifra RJ / mašine |
| `bigtehn_machines_cache` | `name` | naziv RJ / mašine |
| `bigtehn_machines_cache` | `department_id` | BigTehn odeljenje |
| `bigtehn_departments_cache` | `name` | naziv odeljenja |
| `bigtehn_work_order_lines_cache` | `machine_code` | RJ na operaciji RN-a |

`v_production_operations` trenutno spaja operacije preko
`bigtehn_work_order_lines_cache.machine_code = bigtehn_machines_cache.rj_code`
i izlaže `original_machine_code`, `effective_machine_code` i
`original_machine_name`.

Naziv UI tabova iz `src/ui/planProizvodnje/departments.js` nije DB podatak.
To je kodirana kategorizacija po `rj_code` prefiksima/listama.

## Read-only query

Query je izvršen read-only kroz Supabase MCP:

```sql
WITH machine_candidates AS (
  SELECT
    m.rj_code,
    m.name AS machine_name,
    m.department_id,
    d.name AS department_name,
    COALESCE(m.no_procedure, false) AS no_procedure,
    CASE
      WHEN lower(translate(coalesce(m.name, ''), 'ŠšĐđČčĆćŽž', 'SsDdCcCcZz')) LIKE '%usluz%' THEN 'machine_name_usluz'
      WHEN lower(translate(coalesce(m.name, ''), 'ŠšĐđČčĆćŽž', 'SsDdCcCcZz')) LIKE '%kooper%' THEN 'machine_name_kooper'
      WHEN lower(translate(coalesce(d.name, ''), 'ŠšĐđČčĆćŽž', 'SsDdCcCcZz')) LIKE '%kooper%' THEN 'department_kooper'
      ELSE 'other'
    END AS match_reason
  FROM public.bigtehn_machines_cache m
  LEFT JOIN public.bigtehn_departments_cache d ON d.id = m.department_id
  WHERE lower(translate(coalesce(m.name, '') || ' ' || coalesce(d.name, ''), 'ŠšĐđČčĆćŽž', 'SsDdCcCcZz')) LIKE '%usluz%'
     OR lower(translate(coalesce(m.name, '') || ' ' || coalesce(d.name, ''), 'ŠšĐđČčĆćŽž', 'SsDdCcCcZz')) LIKE '%kooper%'
)
SELECT
  c.rj_code,
  c.machine_name,
  c.department_id,
  c.department_name,
  c.no_procedure,
  c.match_reason,
  COUNT(v.line_id) AS active_mes_operation_lines,
  COUNT(*) FILTER (
    WHERE v.line_id IS NOT NULL
      AND v.is_done_in_bigtehn IS FALSE
      AND v.rn_zavrsen IS FALSE
      AND (v.local_status IS NULL OR v.local_status <> 'completed')
      AND v.overlay_archived_at IS NULL
  ) AS open_plan_lines,
  COUNT(DISTINCT v.work_order_id) FILTER (WHERE v.line_id IS NOT NULL) AS active_mes_work_orders,
  MIN(v.rn_ident_broj) FILTER (WHERE v.line_id IS NOT NULL) AS sample_rn_min,
  MAX(v.rn_ident_broj) FILTER (WHERE v.line_id IS NOT NULL) AS sample_rn_max
FROM machine_candidates c
LEFT JOIN public.v_production_operations v ON v.original_machine_code = c.rj_code
GROUP BY c.rj_code, c.machine_name, c.department_id, c.department_name, c.no_procedure, c.match_reason
ORDER BY c.rj_code;
```

## Rezultat

| rj_code | naziv | odeljenje | razlog | aktivne linije | otvorene linije | RN uzorak |
|---|---|---|---|---:|---:|---|
| `2.10` | Uslužno struganje | `02` Struganje | naziv sadrži `usluž` | 0 | 0 | - |
| `3.9.1` | Uslužno glodanje | `03` Glodanje | naziv sadrži `usluž` | 4 | 4 | `9000/561` - `9000/564` |
| `5.11` | Površinska zaštita | `09` Kooperacija | odeljenje Kooperacija | 5 | 5 | `9400/2/252` - `9400/590` |
| `9.0` | Kooperacija | `09` Kooperacija | naziv sadrži `kooper` | 177 | 163 | `7351/250` - `9836/99` |
| `9.1` | Nabavka | `09` Kooperacija | odeljenje Kooperacija | 1 | 1 | `9000/212` |

Dodatna provera za `department_id = '09'` i `rj_code LIKE '9.%'` vraća samo:

| rj_code | naziv | odeljenje |
|---|---|---|
| `5.11` | Površinska zaštita | `09` Kooperacija |
| `9.0` | Kooperacija | `09` Kooperacija |
| `9.1` | Nabavka | `09` Kooperacija |

## Predlog seed liste

### Potvrđeno za seed

Ove grupe ulaze u budući seed za `production_auto_cooperation_groups`:

| rj_group_code | group_label | razlog |
|---|---|---|
| `2.10` | Uslužno struganje | eksplicitan BigTehn naziv |
| `3.9.1` | Uslužno glodanje | eksplicitan BigTehn naziv |
| `9.0` | Kooperacija | korisnik potvrdio 2026-04-25 |

Napomena: `2.10` trenutno nema aktivne MES operacije u `v_production_operations`,
ali ga treba seedovati ako je poslovno pravilo da je svako uslužno struganje
eksterna obrada.

### Za potvrdu pre seed-a

Ove grupe jesu vezane za BigTehn odeljenje `Kooperacija`, ali nisu sve jednako
jasne kao `Uslužno...` nazivi:

| rj_group_code | group_label | preporuka |
|---|---|---|
| `5.11` | Površinska zaštita | Potvrditi. U postojećem UI-u je tematski svrstana u "Farbanje i površinska zaštita", ali BigTehn odeljenje joj je Kooperacija. |
| `9.1` | Nabavka | Ne seedovati bez potvrde. Može biti administrativni/ulazni korak, ne nužno proizvodna kooperacija. |

## Zaključak

Za G7 Fazu B preporučujem:

1. Seedovati `2.10`, `3.9.1` i `9.0`.
2. Pre implementacije potvrditi da li u seed ulaze i `5.11` ili `9.1`.
3. Lookup tabela treba da bude eksplicitni autoritet. Ne treba raditi runtime
   `LIKE '%usluž%'` ili `department_name = 'Kooperacija'` u view-u, jer to
   može greškom povući `Nabavka` ili buduće pomoćne RJ vrednosti.

## Otvorena pitanja

1. Da li `5.11 Površinska zaštita` ostaje u operativnom planu pod "Farbanje i
   površinska zaštita", ili ide u auto-kooperaciju?
2. Da li `9.1 Nabavka` treba uopšte prikazivati u proizvodnom planiranju ili je
   samo prateći administrativni korak?
