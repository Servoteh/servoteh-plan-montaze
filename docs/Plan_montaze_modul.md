# Plan Montaže — dokumentacija

Modul **Plan Montaže** je centralan deo `servoteh-plan-montaze` aplikacije: planiranje i praćenje faza montaže po **projektima** i **pozicijama (work packages)**, sa desktop tabelom, mobilnim karticama, Gantt prikazima, podsetnicima, eksportom i lokalno keširanim 3D meta-podacima po fazi.

**Tehnički detalj šeme** (tabele `projects`, `work_packages`, `phases`, `user_roles`, `reminder_log` i dr.): vidi [SUPABASE_PUBLIC_SCHEMA.md](./SUPABASE_PUBLIC_SCHEMA.md) i `sql/schema.sql` + `sql/migrations/`.

---

## Uloga modula

| | |
|---|---|
| **Svrha** | Operativni plan: ko šta radi, gde, kada, procenat, checklist, blokatori, rizici. Agregatni (ukupni) Gantt preko svih projekata. |
| **Korisnici** | `admin`, `leadpm`, `pm`, `menadžment` imaju **izmenu**; `hr` i `viewer` mogu ući u modul ali rade u **read-only** režimu gde `canEdit()` vraća false (dugmad, drag, import su onemogućeni). Lojika: `src/state/auth.js` → `canEdit()`. |
| **Ruta** | `/plan-montaze` (History API, SPA). Hub čuva poslednji modul u `sessionStorage` (`SESSION_KEYS.MODULE_HUB`). |
| **Ulaz** | Modul se otvara sa hub ekrana (kartica „Plan Montaže”) — `src/ui/hub/moduleHub.js`. |

---

## Model podataka (aplikacijski)

- **Projekat** — šifra, naziv, rok, PM/Lead e-mail, status (`active` / `completed` / `archived`), `reminder_enabled` za e-mail podsetnike.
- **Pozicija (work package / RN)** — pripada projektu; podrazumevano polja mesta, odgovornog, roka, sort order.
- **Faza** — pripada WP-u: naziv, tip (`mechanical` / `electrical`), lokacija, datumi početka/kraja, inženjer, vođa montaže, status (0–3 mapiran na etikete u UI), %, 8 check polja, blokator, napomene, itd.
- **Strano na klijentu (localStorage)**: mape **boje po lokaciji** (`STORAGE_KEYS.LOC_COLOR`) i **3D / slika metapodaci** po `phaseId` (`STORAGE_KEYS.PHASE_MODEL`) — nisu sami po sebi u Supabase tabeli `phases` (sidecar isključivo u browseru).

---

## Tri pogleda (tabovi)

Render: `viewTabsHtml()` u `src/ui/planMontaze/shared.js` · stanje: `planMontazeState.activeView` u `src/state/planMontaze.js`.

| Tab | ID | Sadržaj |
|-----|------|---------|
| **Plan** | `plan` | Zona podsetnika + desktop **plan tabela** + **mobilne kartice** (isti WP). |
| **Gantt** | `gantt` | Gantogram **samo za aktivni WP** — dnevne kolone, trake po fazama, drag/resize. |
| **Ukupan Gant** | `total` | Gantt **preko (filtriranih) svih projekata** — filteri, po-WP uključivanje, grupisani redovi. |

---

## Pregled: Plan

### Desktop tabela

- **Fajl**: `src/ui/planMontaze/planTable.js` · poslovna pravila i save: `planActions.js`.
- **Kolone (ukratko)**: redni broj, naziv (sa chipom meh./el.), lokacija, početak, kraj, trajanje, inženjer, vođa, status, %, osam checklist polja, spremnost, rizik, blokator, napomena, akcije.
- **Filter bar** ograničava prikaz (pretraga, lokacija, status, vođa, spremnost, datumi, rizik) — postavlja `planMontazeState.filteredIndices`.
- **Dodaj fazu**, pomeraj red, briši: preko `canEdit()`.
- **3D / model**: dugme otvara `modelDialog.js` — čuva u `phaseModels[phaseId]` (localStorage). Pravi 3D viewer u aplikaciji nije ugrađen; skladište su URL-ovi slike i fajla + beleška.
- **🔗 Veza sa**: chip pored 3D dugmeta. Otvara `linkedDrawingsDialog.js` — modal za upravljanje listom **brojeva sklopnih crteža** (`drawing_no`) potrebnih za fazu. Vidi posebnu sekciju ispod.

### Mobilne kartice

- **Fajl**: `src/ui/planMontaze/mobileCards.js`.
- Isti WP kao tabela, **filtar** se deli sa tabelom. Otvorene kartice pamte se u `expandedMobileCards` (Set) da UX ostane stabilan posle izmena.

### Zona podsetnika (reminder)

- **Fajl**: `src/ui/planMontaze/reminderZone.js`.
- Skenira **sve faze aktivnog projekta** (kroz WP-ove): faze koje nisu završene, imaju `start_date` u narednih 0–7 dana i **nisu spremne** (readiness) prikazuju se kao urgentno / upozorenje.
- Ako su na projektu uključeni mejlovi i korisnik može da edituje, prikazuje se dugme za slanje podsetnika (modal: `reminderModal.js`).

### Meta: projekat i pozicija

- `metaModals.js` — uredi projekat / uredi work package (nazivi, rokovi, podrazumevani odgovorni, itd.).

---

## Pregled: Gantt (pojedinačni)

- **Fajl**: `src/ui/planMontaze/gantt.js` + `ganttDrag.js`.
- Mesečni + dnevni zaglavlja; trake u boji **lokacije**; stil ivice po tipu faze (meh./el.).
- **Drag** cele trake i **resize** levi/desni kraj; promene vode u debounced `queuePhaseSaveByIndex` preko `src/services/plan.js`.
- **Selekcija dana** (klik, Shift+raspon) u `selectedDateIndices.gantt`.
- Toggle **„Prikaži završene”** — `STORAGE_KEYS.GANTT_SHOW_DONE`.

---

## Pregled: Ukupan Gantt (Total)

- **Fajl**: `src/ui/planMontaze/totalGantt.js`.
- **Filteri**: lokacija, vođa, inženjer, projekat, opseg datuma; lista WP-ova sa **checkbox**-om po poziciji (`totalGanttWPs`).
- Isti Gantt mehanizam (drag/resize) kao pojedinačni; redovi su grupisani: projekat → WP → faze.
- Ograničenje širine vremenske ose: praktično do ~730 dana radi performansi (komentar u kodu).

---

## Veza sa crtežima (linked drawings)

Polje na fazi koje povezuje **sklopne crteže iz BigTehn-a** (PDF u Supabase Storage bucket-u `bigtehn-drawings`) sa fazom montaže.

- **DB**: kolona `phases.linked_drawings jsonb NOT NULL DEFAULT '[]'` — niz stringova, svaki je `bigtehn_drawings_cache.drawing_no` (analogno `phases.checks` patternu). Migracija: `sql/migrations/add_phases_linked_drawings.sql`. RLS prati postojeće `phases_*` policy-je (`has_edit_role(project_id)`); nema posebnih policy-ja.
- **State (UI)**: `phase.linkedDrawings: string[]` — postavljeno preko `mapDbPhase` (read), `buildPhasePayload` (write) u `src/services/projects.js` i `createBlankPhase` u `src/state/planMontaze.js`. Ako migracija nije pokrenuta, `setPhaseLinkedDrawingsSchemaSupported(false)` graceful fallback prati postojeći obrazac za `description` / `phase_type`.
- **Service sloj**: `src/services/drawings.js` (deljen sa modulom *Praćenje proizvodnje*) — `listDrawingsForRnCode(rnCode)`, `listDrawingsForWorkPackage(wp)`, `getDrawingByNumber(no)`, `openDrawingPdf(no)`, `getBigtehnDrawingSignedUrl(no)`. `planProizvodnje.js` re-exportuje `getBigtehnDrawingSignedUrl` radi backward-compat.
- **Keš**: `rnDrawingsCache` (Map) u `state/planMontaze.js`, TTL 60 s — koristi se prilikom otvaranja modala da dropdown crteža RN-a ne re-fetch-uje na svaki klik.
- **UI**:
  - Desktop chip `🔗 Veza sa (N)` u `planTable.js` (kolona „Naziv“, pored 3D dugmeta). Hover preview prvih 5 brojeva.
  - Mobile red `🔗 Veza sa: SC-12345, SC-12346` u `mobileCards.js`. Svaki broj je klikabilan link → otvara PDF.
  - Modal: `src/ui/planMontaze/linkedDrawingsDialog.js` (Sekcija A: trenutna lista; Sekcija B1: dropdown crteža RN-a; Sekcija B2: ručni unos). Read-only za uloge bez `canEdit()` (`hr`, `viewer`).
- **Save**: kroz postojeći debounced queue (`updatePhaseField('linkedDrawings', …)` → `queuePhaseSaveByIndex(i)` → `savePhaseToDb`).
- **Eksport**: JSON sadrži polje (verzija `_version: '5.3'`); XLSX dodaje kolonu „Veza sa (crteži)“ sa zarezima razdvojenim brojevima. Import starijeg JSON-a (bez polja) tretira fazu kao `linkedDrawings: []`.

---

## Eksport / import

- **Fajl**: `src/ui/planMontaze/exportModal.js` (header: dugme **Export** u `index.js`).
- **JSON** — pun snapshot (uključuje sidecar: `phaseModels`, `locationColorMap`), verzionisan za kompatibilnost sa starijim formatom.
- **XLSX** — list „Plan montaže” + sumarno; SheetJS se učitava lazy preko `src/lib/xlsx.js`.
- **PDF** — Pojedinačni ili Total Gantt (html2canvas + jsPDF, `src/lib/pdf.js`); pre Total PDF-a UI može privremeno prebaciti pogled.
- **Import JSON** — zamena `allData` (samo za uloge sa `canEdit()`), sa potvrdom.

---

## Status snimanja i mreža

- **Fajl**: `src/ui/planMontaze/statusPanel.js`.
- Fiksni panel (donji ugao): **online/offline** + **red čekanja / u toku** save-ova, poslednja greška. Subscribe na `subscribeSaveStatus` / `subscribeConnState` u `src/services/plan.js`.
- Učitavanje: `fetchAllProjectsHierarchy()`; offline primer: `bootstrapFromLocalCache()` iz `state/planMontaze.js` (keš `STORAGE_KEYS.LOCAL`).

---

## Glavni fajlovi (referenca)

| Oblast | Fajl |
|--------|------|
| Ulaz modula, shell, tabovi | `src/ui/planMontaze/index.js` |
| Stanje, keš, boje, Gantt pomoć | `src/state/planMontaze.js` |
| API, debounce, save queue | `src/services/plan.js` · CRUD nivo u `src/services/projects.js` |
| Tabela, filteri, add/move/delete | `planTable.js`, `planActions.js` |
| Gantt | `gantt.js`, `ganttDrag.js`, `lib/gantt.js` |
| Total Gantt | `totalGantt.js` |
| Mobilni redovi | `mobileCards.js` |
| Reminderi | `reminderZone.js`, `reminderModal.js` |
| 3D meta | `modelDialog.js` |
| Veza sa crtežima | `linkedDrawingsDialog.js` · servis `src/services/drawings.js` |
| Dugi opis / beleške | `descriptionDialog.js` |
| Eksport | `exportModal.js` |
| Status | `statusPanel.js` |
| Stil | `src/styles/legacy.css` (sekcije plan / gantt) |

---

## Povezano

- [README.md](../README.md) — uloge, setup, deploy.
- [MIGRATION.md](../MIGRATION.md) — Faza 5 (Plan modul) status.
- [MOBILE.md](./MOBILE.md) — PWA rute; Plan modul nije zasebna mobile pod-ruta, ali hub deli istu aplikaciju.
- [SUPABASE_PUBLIC_SCHEMA.md](./SUPABASE_PUBLIC_SCHEMA.md) — kolone i FK za `public` šemu.

---

*Poslednje ažuriranje dokumenta: 2026-04-22 (stanje koda u repou).*
