/**
 * Native barcode scanner wrapper (Capacitor).
 *
 * Na Android APK-u koristimo `@capacitor-mlkit/barcode-scanning` jer:
 *   - 10× brži od web ZXing-a u WebView-u (ML Kit je hardware-accelerated);
 *   - radi fokus/torch native (bolji UX);
 *   - ne zavisi od kamera-permisija u WebView-u (koje Android često blokira).
 *
 * Na web-u (Chrome/Safari) ovaj modul NE zove ništa — scanModal čuva svoj
 * postojeći ZXing flow. API `isNativeBarcode()` je jedini sinhroni kontakt
 * koji scanModal koristi za branching.
 *
 * ML Kit plugin radi kao FULL-SCREEN native overlay — znači dok je otvoren,
 * naš WebView ne prikazuje ništa. Kad korisnik odskeniura, overlay se
 * zatvara i vraća rezultat. Zbog toga u mobileHome "Skeniraj" flow prvo
 * zove `scanNativeOnce()` (await), pa tek zatim otvara formu sa
 * parsiranim rezultatom — umesto da pokušava da pokrene kameru u <video>.
 */

/**
 * Vrati true ako je app pokrenut kao Capacitor native (Android APK).
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
 * Skeniraj jednom preko ML Kit native overlay-a. Vraća sirovi tekst
 * (prvi barkod koji uspe da dekoduje) ili `null` ako je korisnik
 * otkazao / nije podržano.
 *
 * @returns {Promise<string|null>}
 */
export async function scanNativeOnce() {
  if (!isNativeCapacitor()) return null;

  try {
    const { BarcodeScanner } = await import('@capacitor-mlkit/barcode-scanning');

    /* Provera Google Barcode Scanner Module-a (tek posle prve instalacije
     * je dostupan). Ako nije, pokušaj install — ovo traži Google Play
     * Services. Na uređajima bez PlayServices (retko, ali npr. Huawei)
     * fall-back na ZXing. */
    const installed = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
    if (!installed.available) {
      try {
        await BarcodeScanner.installGoogleBarcodeScannerModule();
      } catch (e) {
        console.warn('[native-scan] failed to install ML Kit module', e);
        return null;
      }
    }

    /* Permisije. Capacitor + @capacitor-mlkit sam pita WebView permission,
     * ali na nekim Android verzijama treba explicit request. */
    const perm = await BarcodeScanner.requestPermissions();
    if (perm.camera !== 'granted' && perm.camera !== 'limited') {
      return null;
    }

    const result = await BarcodeScanner.scan({
      /* Code128 je BigTehn format; Code39 rezerva; QR kao opšte slučaje. */
      formats: ['CODE_128', 'CODE_39', 'QR_CODE', 'EAN_13', 'EAN_8'],
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
