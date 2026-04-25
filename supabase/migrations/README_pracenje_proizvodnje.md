# Praćenje proizvodnje — backend migracija

Ovaj folder sadrži draft backend osnov za modul **Praćenje proizvodnje**. SQL se ne pokreće automatski; korisnik ga primenjuje ručno posle pregleda.

## Fajlovi

- `20260425124400__pracenje_proizvodnje_init.sql` — up migracija: šeme, enumi, core/pdm/production tabele, indeksi, view-ovi, RPC funkcije, helperi, audit triggeri, RLS politike, seed odeljenja i komentari.
- `20260425124400__pracenje_proizvodnje_init.down.sql` — rollback migracija u obrnutom redosledu.
- `../seeds/pracenje_proizvodnje_test.sql` — minimalni test fixture za jedan RN.

## Redosled pokretanja

1. Pregledati `20260425124400__pracenje_proizvodnje_init.sql`.
2. Pokrenuti up migraciju ručno.
3. Pokrenuti test seed:

```sql
\i supabase/seeds/pracenje_proizvodnje_test.sql
```

4. Uraditi smoke test RPC-a:

```sql
select production.get_pracenje_rn('55555555-5555-5555-5555-555555555501');

select production.get_operativni_plan(
  p_rn_id => '55555555-5555-5555-5555-555555555501'
);
```

Očekivani oblik outputa:

- `get_pracenje_rn` vraća JSON sa `header`, `summary` i `positions`.
- `get_operativni_plan` vraća JSON sa `header`, `activities` i `dashboard`.
- Test fixture ima 4 operativne aktivnosti sa efektivnim stanjima: `nije_krenulo`, `u_toku`, `blokirano`, `zavrseno`.

## Rollback

Rollback se vrti ručno:

```sql
\i supabase/migrations/20260425124400__pracenje_proizvodnje_init.down.sql
```

Rollback drop-uje samo objekte koje kreira ova migracija. Šeme `core`, `production` i `pdm` se drop-uju samo ako su prazne nakon uklanjanja objekata.

## Poznata ograničenja i TODO

- Realtime nije konfigurisan u ovom inkrementu.
- Nema frontend koda ni TypeScript tipova.
- Nema `legacy.*` import skripti; `legacy_*` kolone su nullable i služe za kasniju migraciju.
- `core.partneri` / `core.cases` nisu uvedeni u ovom inkrementu; `radni_nalog.kupac_text` je privremeni snapshot.
- RPC `get_pracenje_rn` vraća flat listu pozicija sa `parent_id`; UI u sledećem inkrementu treba da je renderuje kao tree-grid.
- RLS select je namerno širi za `authenticated`, u skladu sa postojećim internim patternom; write ide kroz `production.can_edit_pracenje`.
