# CMMS seed šabloni

Ovaj folder sadrži **šablone**, ne stvarne podatke firme.

## Fajlovi

- [`cmms_seed_template.sql`](cmms_seed_template.sql) — komentarisani `INSERT` primeri za lokacije, sredstva, dobavljače, delove i preventivne šablone.

## Kako koristiti

1. Kopiraj `cmms_seed_template.sql` u novi fajl (npr. `cmms_seed_production_2026.sql`) van repozitorijuma ako želiš da držiš osetljive podatke lokalno.
2. Zameni placeholder UUID-ove i tekstualne vrednosti stvarnim podacima.
3. Izvrši SQL na odgovarajućoj bazi (preporuka: prvo staging, pa produkcija).
4. Ne commit-uj fajlove sa pravim PII ili internim šiframa.

Za brzi pregled procesa vidi i [`docs/maintenance_quick_guide.md`](../docs/maintenance_quick_guide.md).
