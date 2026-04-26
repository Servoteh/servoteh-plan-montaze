# Praćenje proizvodnje — frontend smoke test

## Aktivacija predmeta

Lista na prvom ekranu dolazi iz `public.get_aktivni_predmeti()` — predmeti sa **`production.predmet_aktivacija.je_aktivan = true`** (nema uslova na MES / `v_active_bigtehn_work_orders`).

Uključivanje/isključivanje predmeta: **Podešavanja → Podeš. predmeta** (admin + menadžment). Vidi [docs/migration/07-predmet-aktivacija.md](../../../docs/migration/07-predmet-aktivacija.md).

## Otvaranje modula (Aktivni predmeti + Inkrement 2)

Bez `?rn=` modul učitava listu: **Red. br.**, **Broj predmeta**, **Naziv predmeta**, **Komitent**, **Rok za završetak** (`rok_zavrsetka` iz `bigtehn_items_cache` preko `get_aktivni_predmeti()`), **Prioritet** (samo admin — strelice). Klik na red otvara **ekran 2** (`?predmet=<item_id>`): stablo iz `get_podsklopovi_predmeta`. Klik na RN poziva `ensure_radni_nalog_iz_bigtehn` + `loadPracenje` i `?rn=<uuid>`.

**URL:**

- Lista: `/pracenje-proizvodnje` (ili bez query-ja koji nisu `rn`/`predmet`)
- Stablo: `?predmet=810102` (nakon seed-a `bigtehn_rn_components_test.sql`)
- Inkrement 2: `?rn=<uuid|broj>` (direktan ulaz, kao ranije)

Ruta modula:

```text
/pracenje-proizvodnje?rn=55555555-5555-5555-5555-555555555501#tab=po_pozicijama
```

Test RN ID iz Inkrementa 1 seed-a:

```text
55555555-5555-5555-5555-555555555501
```

Tabovi su deep-linkable:

```text
#tab=po_pozicijama
#tab=operativni_plan
```

## Ručni smoke (Aktivni predmeti)

1. Otvori modul bez `?rn=` — vidiš listu predmeta uključenih u Podešavanjima (Podeš. predmeta, `je_aktivan = true`).
2. Ako postoji seed `bigtehn_rn_components_test.sql`: klik na **Predmet C** (`810102`) — stablo sa više nivoa; klik na podsklop koji ima RN — otvara se Inkrement 2.
3. **Nazad** u stablu (`← Nazad na listu predmeta`) → lista; browser **Back** vraća kroz istoriju (`?predmet=` ↔ lista ↔ `?rn=`).
4. **Admin:** u listi vidiš strelice ↑ ↓; klik ↓ na prvom redu → redosled se menja; refresh stranice → redosled ostaje (server `shift_predmet_prioritet`).
5. **Non-admin:** nema strelica; `set_predmet_prioritet` / `shift` na backend-u vraćaju `forbidden` / RLS.

## Očekivano ponašanje

(Prikaz u listi zavisi samo od Podeš. predmeta; u stablu / RN-ovima i dalje postoje MES indikatori gde su definisani u SQL-u.)
