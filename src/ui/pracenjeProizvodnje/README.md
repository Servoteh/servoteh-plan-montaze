# Praćenje proizvodnje — frontend smoke test

## Otvaranje modula

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

## Očekivano ponašanje

- Header se učita sa kupcem, RN brojem, datumom isporuke, koordinatorom i agregatima.
- Tab `Po pozicijama` prikazuje 3 pozicije i 5 operacija iz seed-a.
- Expand/collapse radi preko native `<details>/<summary>`.
- Tab `Operativni plan` prikazuje 4 aktivnosti i dashboard.
- Status badge prikazuje auto indikator kada `status_is_auto = true`.
- Dugme `Nova aktivnost` je vidljivo samo ako `production.can_edit_pracenje` vrati `true`.
- Posle dodavanja/izmene/zatvaranja aktivnosti state se osvežava iz RPC-ja.

## Inkrement 3 ručni testovi

- Promocija akcione tačke: napravi/open akcioni plan za isti `projekat_id`, klikni `Iz akcione tačke`, izaberi odeljenje, promoviši i potvrdi da se aktivnost vidi u Tab 2 sa izvorom `iz_sastanka`.
- Excel export: klikni `Excel export` na oba taba i otvori fajlove `pracenje_<rn>_po_pozicijama_<YYYYMMDD>.xlsx` i `pracenje_<rn>_operativni_plan_<YYYYMMDD>.xlsx`.
- Napredni filteri: kombinuј 3+ filtera (odeljenja, statusi, prioritet, rok, kasni), refreshuj stranicu i proveri da se filteri vraćaju iz URL/localStorage stanja.
- Polling refresh: otvori isti RN u dva taba browser-a, izmeni aktivnost u jednom i sačekaj do 30s da drugi tab prikaže osveženje.
- Side-panel prijava: na Tab 1 klikni red operacije i proveri listu `prijava_rada` za poziciju + TP operaciju.
- Audit istorija: u modal aktivnosti otvori tab `Istorija`, postavi/skini blokadu i proveri da se vidi istorija blokada; audit log je vidljiv samo ako RLS dozvoli korisniku čitanje.

## Poznata ograničenja

- Pravi Supabase websocket realtime nije uveden jer projekat trenutno koristi custom REST `sbReq`, ne Supabase JS realtime client. Modul koristi polling fallback od 30s.
- Export audit je best-effort upis u postojeći `audit_log`; ako RLS odbije direktan insert, export se ne prekida.
- Deep-link na originalnu akcionu tačku vodi na `/sastanci?akcija=<id>`; modul Sastanci ne menja se u ovom inkrementu.
- Dokumentacija/crteži u Tab 1 side-panelu ostaju placeholder dok se ne uvedu fajl tabele za TP operacije/PDM linkovi u runtime payload.
