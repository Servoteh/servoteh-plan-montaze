/**
 * Native barcode scanner wrapper (Capacitor).
 *
 * Koristimo `@capacitor-mlkit/barcode-scanning` na native platformama jer:
 *   - 10× brži od web ZXing-a u WebView-u (ML Kit je hardware-accelerated);
 *   - radi fokus/torch native (bolji UX);
 *   - ne zavisi od kamera-permisija u WebView-u (koje Android često blokira).
 *
 * Platformne razlike koje ovaj modul sakriva:
 *   - **Android**: ML Kit koristi "Google Barcode Scanner Module" koji se
 *     on-demand instalira iz Google Play Services. Moramo da proverimo
 *     prisutstvo i instaliramo pre prvog skeniranja.
 *   - **iOS**: ML Kit je embedovan direktno u aplikaciju (nema modul sa
 *     strane). `isGoogleBarcodeScannerModuleAvailable` BACA grešku na iOS-u,
 *     pa moramo da ga preskočimo.
 *   - **Web**: ne koristi se — scanModal koristi ZXing in-WebView. API
 *     `isNativeCapacitor()` je jedini sinhroni kontakt koji kod koristi
 *     za branching.
 *
 * ML Kit plugin radi kao FULL-SCREEN native overlay — znači dok je otvoren,
 * naš WebView ne prikazuje ništa. Kad korisnik odskenira, overlay se
 * zatvara i vraća rezultat. Zbog toga u mobileHome "Skeniraj" flow prvo
 * zove `scanNativeOnce()` (await), pa tek zatim otvara formu sa
 * parsiranim rezultatom — umesto da pokušava da pokrene kameru u <video>.
 */

/**
 * Vrati true ako je app pokrenut kao Capacitor native (Android APK ili iOS IPA).
 * Korisno i izvan scannera (npr. za auto-redirect na `/m` u main.js).
 */
export function isNativeCapacitor() {
  try {
    return !!(
      typeof window !== 'undefined' &&
      window.Capacitor?.isNativePlatform?.()
    );
  } catch {
    return false;
  }
}

/**
 * Vrati string platforme ('android' | 'ios' | 'web').
 */
export function getCapacitorPlatform() {
  try {
    return window?.Capacitor?.getPlatform?.() || 'web';
  } catch {
    return 'web';
  }
}

/**
 * Skeniraj jednom preko ML Kit native overlay-a. Vraća sirovi tekst
 * (prvi barkod koji uspe da dekoduje) ili `null` ako je korisnik
 * otkazao / nije podržano.
 *
 * @returns {Promise<string|null>}
 */
export async function scanNativeOnce() {
  if (!isNativeCapacitor()) return null;
  const platform = getCapacitorPlatform();

  try {
    const { BarcodeScanner } = await import('@capacitor-mlkit/barcode-scanning');

    /* Google Barcode Scanner Module je Android-only koncept. Na iOS-u
     * je ML Kit statički linkovan u IPA i provera nije potrebna — zapravo
     * `isGoogleBarcodeScannerModuleAvailable()` baca grešku "not implemented"
     * na iOS-u. Zato ga zovemo samo na Androidu. */
    if (platform === 'android') {
      const installed = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
      if (!installed.available) {
        try {
          await BarcodeScanner.installGoogleBarcodeScannerModule();
        } catch (e) {
          console.warn('[native-scan] failed to install ML Kit module', e);
          return null;
        }
      }
    }

    /* Permisije. Na iOS-u ova poruka prikazuje `NSCameraUsageDescription`
     * iz Info.plist-a; na Androidu traži CAMERA permission. */
    const perm = await BarcodeScanner.requestPermissions();
    if (perm.camera !== 'granted' && perm.camera !== 'limited') {
      return null;
    }

    const result = await BarcodeScanner.scan({
      /* Code128 je BigTehn format; Code39 rezerva; QR kao opšte slučaje. */
      formats: ['CODE_128', 'CODE_39', 'QR_CODE', 'EAN_13', 'EAN_8'],
      /**
       * iOS/Android ML Kit: automatski zumira kad detektuje mali 1D barkod
       * u kadru — neophodno za RN nalog u uglu A4 (sitno u odnosu na ceo list).
       * @see ScanOptions.autoZoom (plugin ≥7.4.0)
       */
      autoZoom: true,
    });

    const first = result?.barcodes?.[0];
    return first?.rawValue || first?.displayValue || null;
  } catch (e) {
    /* Korisnik otkazao = odbij silently; svaka druga greška ide u log. */
    if ((e && e.message || '').toLowerCase().includes('cancel')) return null;
    console.error('[native-scan] failed', e);
    return null;
  }
}
