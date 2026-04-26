# Migracija: `20260426120000__bigtehn_rn_components_cache_init`

## Šta se dodaje u bazu

| Objekat | Opis |
|--------|------|
| `public.bigtehn_rn_components_cache` | 1 tabela: edge parent RN → child RN (legacy `tRNKomponente`), PK `id` = `IDKomponente` |
| RLS | 1 × SELECT `authenticated` + 3 × odbijen INSERT/UPDATE/DELETE (pisanje ostaje `service_role`) |
| `public.v_bigtehn_rn_struktura` | Rekurzivni pogled: stablo po predmetu od MES-„root” RN-ova; max **10** nivoa; zaštita od ciklusa preko `path_idrn` |
| `public.v_bigtehn_rn_root_count` | `(predmet_item_id, root_count)` za badge / Fazu A |
| **Indeksi (na tabeli)** | PK `id`, UNIQUE `(parent_rn_id, child_rn_id)` (implicitni indeks), `brncc_parent_idx`, `brncc_child_idx` — **2** eksplicitna + UNIQUE |

**Ukupno u šemi (sažetak):** 1 tabela, 2 view-a, 4 RLS politike, indeksi: PK + UNIQUE + 2 pomoćna = **4** indeks-fajla na tabeli (uključujući granični UNIQUE par).

**Rollback:** `20260426120000__bigtehn_rn_components_cache_init.down.sql` (view-ovi, pa tabela).

## Ograničenja

- **Ciklus u legacy podacima:** CTE ograničen na 10 nivoa; rekurzija se reže i ako bi `child_rn_id` već bio u `path_idrn` (nije PostgreSQL 14+ `CYCLE` klauzula zbog prenosa na više instanci, ali ista ideja).
- **Više roditelja:** isti `child` RN se može pojaviti u više grana (više redova u izlazu) ako postoji više `tRNKomponente` parent→child veza.
- **Root definicija:** RN je root ako je u `v_active_bigtehn_work_orders`, ima `item_id`, i **nije** `child_rn_id` nijednog reda u cache tabeli. Deca ne moraju biti u MES aktivnim.

## Worker (`backfill-production-cache.js`)

- Nova tabela u sync pipeline-u: `rn-components` → `dbo.tRNKomponente` → `bigtehn_rn_components_cache`.
- **Bez** filtera `StatusRN` na parent RN-u (cela tabela, `skipOpenFilter: true`); `scope=open` i `scope=all` daju **isti** set komponenti.
- Posle upsert-a (i kada **nema** `--limit`): brisanje „sirotica” u Supabase — id-jevi koji više nisu u MSSQL. Sa `--limit` ovo se **ne radi** (delimičan uzorak).
- MSSQL u exportu **nema** `DatumIVreme` na `tRNKomponente` → `modified_at` u cache-u ostaje `NULL`; `synced_at` puni worker.

### Uključivanje / isključivanje

Samo odabirom tabela:

```bash
# Samo komponente (i dalje puna tabela tRNKomponente u MSSQL)
node scripts/backfill-production-cache.js --tables=rn-components --scope=open

# Bez komponenti (ponašanje kao ranije, ako tabela nije u listi)
node scripts/backfill-production-cache.js --tables=work-orders,lines,tech,rework-scrap
```

Nema posebnog env var-a; `TABLE_ORDER` u skripti uključuje `rn-components` na kraju.

## Smoke SQL (nakon deploy-a i, po želji, `supabase/seeds/bigtehn_rn_components_test.sql`)

Zameniti `810102` test `predmet_item_id` iz seed-a:

```sql
SELECT * FROM v_bigtehn_rn_struktura
WHERE predmet_item_id = 810102
ORDER BY nivo, rn_id;

SELECT * FROM v_bigtehn_rn_root_count
WHERE predmet_item_id = 810102;
```

**Provera broja redova u cache-u nakon backfill-a:**

```sql
SELECT count(*) AS n FROM public.bigtehn_rn_components_cache;
-- Uporediti sa: SELECT COUNT(*) FROM dbo.tRNKomponente; na MSSQL
```

## Sledeći korak (izvan ovog repoa)

1. `supabase db push` / primena migracije na vezanu instancu.
2. `node scripts/backfill-production-cache.js` (uključuje `rn-components` u default lancu) ili samo `rn-components`.
3. Gornji smoke + validacija Faze A (RPC `get_podsklopovi_predmeta`) na ovim view-ovima.
