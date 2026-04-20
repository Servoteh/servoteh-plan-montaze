# Servoteh Lokacije — mobilna aplikacija

Mobilni shell za magacionere i viljuškariste. Radi u dve varijante iz istog
koda:

1. **PWA** u bilo kojem modernom mobilnom browseru (Chrome, Safari,
   Samsung Internet) — korisnik otvori `https://<poddomen>.pages.dev/m`,
   ima opciju „Dodaj na početni ekran" i app se ponaša kao native
   (offline cache, fullscreen).
2. **Android APK** — isti web kod spakovan u Capacitor wrapper, plus
   native barcode scanner (Google ML Kit) koji je ~10× brži od web
   ZXing-a. Distribuira se manuelno (USB/Telegram) — **nije na Play
   Store-u**.

Nema iOS verzije (user explicit requirement — samo par Android telefona).

---

## 1. Šta magacioner vidi

Home ekran (`/m`) ima samo 4 stvari:

- **📷 SKENIRAJ BARKOD** — otvara kameru, auto-parsiraj `NALOG/CRTEŽ` iz
  BigTehn nalepnice, prikaže formu za izbor lokacije i količine.
- **⌨ RUČNI UNOS** — isti flow, ali bez kamere (ako nalepnica fali ili je
  oštećena).
- **📋 MOJA ISTORIJA** — poslednjih 50 premeštanja koje je ovaj korisnik
  zabeležio (sa vremenom, lokacijama, količinom).
- **🗂 BATCH MOD** — skeniraj N komada zaredom, pa jednim klikom pošalji
  sve u istu lokaciju (npr. prebacivanje cele palete na policu K-A3).

Sve interakcije imaju min tap target 72px (dovoljno za prste sa
rukavicama) i dodatni vibrate feedback na uspeh/grešku.

## 2. Offline queue

Ako WiFi nestane usred skeniranja:
- skeniranje se **ne gubi** — upisuje se u lokalni queue (localStorage);
- home ekran pokazuje `⏳ N čeka` badge umesto `✓ sinhronizovano`;
- čim se WiFi vrati, queue se automatski flush-uje (ili korisnik može da
  klikne badge da forsira pokušaj).

Queue je ograničen na 500 zapisa (safety cap) — praktično nikad nećemo
doći blizu.

Source: `src/services/offlineQueue.js`.

## 3. Arhitektura — kako to sve radi

```
┌──────────────────────────────────┐
│ index.html (#app)                │
│                                  │
│  /                → ERP hub       │
│  /plan-montaze    → Plan modul    │
│  /m               → Mobilni home  │
│  /m/scan          → Kamera scan   │
│  /m/manual        → Ručni unos    │
│  /m/history       → Moja istorija │
│  /m/batch         → Batch skener  │
└──────────────────────────────────┘
         ↓ (svi path-ovi)
     src/ui/router.js

/m/* rute →  src/ui/mobile/*.js
                ↓
         reuse scanModal (lokacije)
                ↓
         Supabase REST / RPC
                ↓
          loc_create_movement
```

Samo na `/m/*` rutama se **registruje Service Worker** — glavni ERP
nema PWA cache da ne blokira brze deploy-eve. Vidi `src/lib/pwa.js`.

## 4. Kako instalirati APK na telefon

### Korak 1 — preuzmi APK

1. Otvori GitHub repo → **Actions** → **Build Android APK** → odaberi
   najnoviji uspešni run.
2. Dole pod **Artifacts** klikni `servoteh-lokacije-*.apk` da ga preuzmeš
   na računar.
3. Prebaci APK na telefon: Telegram (pošalji sebi), Google Drive, USB
   kabl, ili Bluetooth.

### Korak 2 — dozvoli instalaciju iz nepoznatih izvora

Android 8+: **Settings → Apps → Special access → Install unknown apps**,
izaberi browser ili Files aplikaciju preko koje ćeš otvoriti APK →
**Allow from this source**.

### Korak 3 — instaliraj i otvori

1. Na telefonu tap-ni preuzeti `.apk` fajl.
2. Android može prikazati upozorenje "Blocked by Play Protect" → **Install
   anyway** (APK je unsigned jer ne ide na Play Store).
3. Posle instalacije otvori app „Servoteh Lokacije".
4. Prva prijava: isti email + password kao na webu.

### Korak 4 — ažuriranje

Kad pošaljemo novi build, samo preuzmeš novi APK i ponovo ga instaliraš
— Android će ga merge-ovati preko postojećeg (sve podatke zadržava:
istoriju, queue, login).

## 5. PWA alternativa (bez instalacije APK-a)

Za telefone gde ne može APK (npr. iPhone koji bi vlasnik posudio radniku
na par dana), možeš otvoriti:

```
https://<cf-pages-poddomen>.pages.dev/m
```

Na Androidu (Chrome): `⋮ → Add to Home screen`. Na iOS (Safari): `Share
→ Add to Home Screen`. Ikona se pojavi kao obična app. Service Worker
keš-uje CSS/JS da bude brzo i kad je WiFi slab.

Razlika od APK-a:
- **PWA**: koristi web kameru preko ZXing-a (sporije, ali radi).
- **APK**: koristi Google ML Kit native scanner (brže i pouzdanije).

## 6. Dev workflow

### Lokalni preview

```bash
npm run dev
# Otvori http://localhost:5173/m
```

Service Worker je **isključen u dev modu** (da ne ometa HMR). PWA-specific
testing radi na `npm run build && npm run preview`.

### Rebuild APK lokalno

```bash
npm run build
npx cap sync android
cd android
./gradlew assembleDebug
# APK u android/app/build/outputs/apk/debug/app-debug.apk
```

Potrebno:
- JDK 21 (Temurin)
- Android SDK (API 34 minimum — Capacitor 8 default)
- `ANDROID_HOME` env var postavljen

### Rebuild iz Android Studija

```bash
npx cap open android
```

Otvori projekat u Android Studio — tamo možeš ceo stack debugovati, plus
instant run na povezanom telefonu (USB debugging).

## 7. Troubleshooting

### „Kamera ne radi u APK-u"

Prvi put instaliran ML Kit plugin downloaduje Google Barcode Scanner
Module (~2MB) iz Google Play Services. Treba WiFi prvi put. Ako ne radi:
- proveri da telefon ima Google Play Services (Huawei bez HMS neće imati);
- app će automatski fall-back-ovati na web ZXing scanner (sporiji ali
  radi svuda).

### „Radim na WiFi-ju ali kaže `⏳ N čeka`"

Offline queue se flush-uje automatski na `online` event. Ali neki routeri
u hali imaju flaky konekciju (WiFi "je" tu, ali DNS ne radi). Fix:
tap-ni na badge → forsira retry.

### „Kada vratim na web, ne vidim skeniranja odmah"

Pre deploy-a je keš-ovan stari SW. Pravi problem:
1. Otvori web app (`/`);
2. F12 → Application → Service Workers → Unregister;
3. Hard reload.

Ovo se dešava samo magacionerima jer **ERP hub (`/`) nema SW**. U
produkciji: ne bi trebalo da se desi, ali eto ti steps.

## 8. Mapiranje na repo

| Namena                              | Fajl                                      |
| ----------------------------------- | ----------------------------------------- |
| Mobilni shell home + navigacija     | `src/ui/mobile/mobileHome.js`             |
| Istorija „mojih premeštanja"        | `src/ui/mobile/mobileHistory.js`          |
| Batch skener                        | `src/ui/mobile/mobileBatch.js`            |
| Offline queue (LS-based)            | `src/services/offlineQueue.js`            |
| Native barcode (ML Kit) wrapper     | `src/services/nativeBarcode.js`           |
| Mobilni stilovi                     | `src/styles/mobile.css`                   |
| PWA registracija (scoped na `/m`)   | `src/lib/pwa.js`                          |
| Routing (`/m/*` grana)              | `src/ui/router.js`, `src/lib/appPaths.js` |
| Capacitor config                    | `capacitor.config.json`                   |
| Android Gradle projekat             | `android/`                                |
| CI workflow za APK                  | `.github/workflows/android-apk.yml`       |

## 9. Šta NIJE implementirano (i zašto)

- **iOS build** — user explicit zahtev: samo Android. Dodavanje kasnije =
  `npx cap add ios` + Xcode build (treba macOS + Apple Developer account).
- **Play Store distribucija** — APK je unsigned. Kad bi išlo na Store,
  treba Google Play keystore, `gradle signingConfig`, + `bundleRelease`
  (AAB umesto APK). To je 2-3h dodatnog posla; pitaj ako zatreba.
- **Push notifikacije** — nema FCM setup-a (treba Firebase projekat). Za
  sada magacioner otvara app manuelno.
- **Biometric login** — iz magacinskog konteksta nije tražen. Capacitor
  plugin `@capacitor/preferences` + `capacitor-biometric-auth` dodaju
  ovo ako zatreba (sačuvaj refresh token → unlock fingerprint).

## 10. Sigurnost

- APK je **unsigned debug build**. Može se instalirati samo manuelno;
  Android sprečava svako Play Store ažuriranje bez istog keystore-a.
- WebView koristi `androidScheme: 'https'` — tretira se kao Secure
  Origin, što je preduslov za Camera/IndexedDB API.
- Supabase session tokeni su u WebView-ovom localStorage-u (isto kao na
  webu). Nisu accessible iz drugih aplikacija zahvaljujući Android
  sandbox-u.
- Ako je telefon izgubljen: admin može u Supabase dashboardu invalidovati
  sve sessionse za taj email (ili disable-ovati nalog).
