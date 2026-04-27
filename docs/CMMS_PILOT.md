# CMMS — Pilot nedelja (operativno testiranje)

Cilj: jedna nedelja realnog rada kroz modul, sa jasnim učesnicima i beleškom problema.

## Učesnici (preporuka)

- 2–3 osobe iz održavanja (`technician` / `chief`)
- 1–2 operatora (`operator`)
- 1 kontakt za ERP menadžment (`management`) — samo pregled / izuzeci

## Pravila pilota

1. Svi novi kvarovi idu kroz CMMS (incident → WO gde se automatski kreira).
2. Zatvaranje WO samo uz kratak komentar šta je urađeno.
3. Paralelni „papir“ samo kao backup ako modul padne — dogovor unapred.

## Matrica provere uloga (RLS)

Za svaku ulogu, uloguj se kao test korisnik i potvrdi:

| Provera | operator | technician | chief | admin | management |
|--------|:--------:|:----------:|:-----:|:-----:|:------------:|
| Vidi listu mašina / sredstava koja mu pripadaju | | | | | |
| Može prijaviti incident | | | | | |
| Vidi WO dodeljene njemu / na vidljivim sredstvima | | | | | |
| Menja status WO i unosi delove/sate | | | | | |
| Menja `maint_settings` i pravila notifikacija | | | | | |
| Brisanje / hard operacije (ako postoje) | | | | | |

Označi ćeliju sa ✓ ili ✗ i u komentaru navedi šta se desilo (403, prazan ekran, itd.).

## Dnevni ritam

- **Ponedeljak:** kick-off 15 min, podešavanje `maint_settings` i kanala
- **Svaki dan:** 5 min standup — šta je zapelo u modulu
- **Petak:** retrospektiva — popuniti [`CMMS_PILOT_FEEDBACK.md`](CMMS_PILOT_FEEDBACK.md)

## Posle pilota

- Prioritet: samo stavke koje **blokiraju** rad idu odmah u razvoj
- Ostalo ide u backlog sa oznakom „CMMS v2“
