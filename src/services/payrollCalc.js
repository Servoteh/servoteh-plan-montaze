/**
 * payrollCalc.js — KADROVSKA, mesečni obračun zarade.
 *
 * SINGLE SOURCE OF TRUTH za sve formule. Sve funkcije su pure (bez I/O,
 * bez dohvatanja iz baze) — primaju eksplicitne ulaze i vraćaju eksplicitne
 * izlaze. To omogućava jedinstveno testiranje (vidi tests/payrollCalc.test.js)
 * i da i UI i export i RPC mogu da pozivaju iste formule.
 *
 * Compensation model:
 *   - 'fiksno'    → fiksna mesečna zarada + dodaci za prekovremeni / praznik_rad /
 *                   dve mašine po `fixed_extra_hour_rate`. Prevoz je već uračunat
 *                   u fixed_amount (informativna komponenta).
 *   - 'dva_dela'  → first_part_amount + (payable_hours × split_hour_rate) +
 *                   split_transport_amount.
 *   - 'satnica'   → (payable_hours × hourly_rate) + hourly_transport_amount.
 *
 * Bolovanje (po Zakonu o radu RS):
 *   - obično bolovanje (do 30 dana, na teret poslodavca) → 65% osnovice
 *   - povreda na radu / održavanje trudnoće → 100% osnovice
 *
 * Teren: dnevnica × broj dana, dolazi DODATNO uz svaku šemu.
 *   - terrain_domestic_rate × teren_u_zemlji_count       → RSD
 *   - terrain_foreign_rate  × teren_u_inostranstvu_count → EUR (zaseban total)
 *
 * Prava po tipu rada:
 *   - 'ugovor'            → puna prava (godišnji, slobodni dani, plaćen praznik,
 *                            plaćeno bolovanje)
 *   - 'praksa','dualno','penzioner' → BEZ prava na navedene plaćene odsustva.
 *      Ako u ulazu ipak postoje sati za njih, dodaje se WARNING i ti sati se
 *      tretiraju kao 0 u obračunu (ne plaćaju se).
 */

/* ── Konstante (po Zakonu o radu RS, najmanji propisani koeficijenti) ── */
export const REGULAR_DAY_HOURS = 8;
export const BOLOVANJE_OBICNO_FACTOR = 0.65;       // 65% osnovice
export const BOLOVANJE_PUNO_FACTOR = 1.00;         // 100% osnovice
export const VALID_WORK_TYPES = ['ugovor', 'praksa', 'dualno', 'penzioner'];
export const VALID_COMPENSATION_MODELS = ['fiksno', 'dva_dela', 'satnica'];

const FULL_RIGHTS_WORK_TYPES = new Set(['ugovor']);

const NUM = (v) => (v == null || isNaN(v) ? 0 : Number(v));

function pushWarning(arr, code, message, extra = {}) {
  arr.push({ code, message, ...extra });
}

/**
 * Heuristika: ako salary_terms.compensation_model nije postavljen (legacy red),
 * mapira stari salary_type u novi model:
 *   - 'satnica' → 'satnica'
 *   - 'ugovor'  → 'fiksno'
 *   - 'dogovor' → 'fiksno'  (nema bolje pretpostavke; UI obavezno traži novi izbor)
 */
export function deriveCompensationModel(terms) {
  if (!terms) return null;
  if (terms.compensationModel && VALID_COMPENSATION_MODELS.includes(terms.compensationModel)) {
    return terms.compensationModel;
  }
  switch (terms.salaryType) {
    case 'satnica': return 'satnica';
    case 'ugovor':
    case 'dogovor': return 'fiksno';
    default: return null;
  }
}

/**
 * Validira ulazne sate prema tipu rada. Vraća { sanitized, warnings }.
 * Sanitizovani objekat ima 0 za sve "plaćene odsustva" ako tip rada NEMA prava.
 */
export function sanitizeHoursForWorkType(hours, workType) {
  const w = [];
  const safe = { ...hours };

  if (!VALID_WORK_TYPES.includes(workType)) {
    pushWarning(w, 'unknown_work_type',
      `Nepoznat tip rada „${workType}". Tretiram kao bez punih prava.`);
  }

  const hasRights = FULL_RIGHTS_WORK_TYPES.has(workType);
  if (!hasRights) {
    if (NUM(safe.godisnjiSati) > 0) {
      pushWarning(w, 'no_right_godisnji',
        `Tip rada „${workType}" nema pravo na plaćen godišnji odmor — ${NUM(safe.godisnjiSati)}h ignorisano.`);
      safe.godisnjiSati = 0;
    }
    if (NUM(safe.slobodniDaniSati) > 0) {
      pushWarning(w, 'no_right_slobodni',
        `Tip rada „${workType}" nema pravo na plaćene slobodne dane — ${NUM(safe.slobodniDaniSati)}h ignorisano.`);
      safe.slobodniDaniSati = 0;
    }
    if (NUM(safe.praznikPlaceniSati) > 0) {
      pushWarning(w, 'no_right_praznik_placeni',
        `Tip rada „${workType}" nema pravo na plaćene neradne praznike — ${NUM(safe.praznikPlaceniSati)}h ignorisano.`);
      safe.praznikPlaceniSati = 0;
    }
    if (NUM(safe.bolovanje65Sati) > 0 || NUM(safe.bolovanje100Sati) > 0) {
      pushWarning(w, 'no_right_bolovanje',
        `Tip rada „${workType}" nema pravo na plaćeno bolovanje — sati ignorisani.`);
      safe.bolovanje65Sati = 0;
      safe.bolovanje100Sati = 0;
    }
  }

  return { sanitized: safe, warnings: w };
}

/**
 * Računa „payable_hours" (težinski sat-koeficijent) zavisno od modela.
 *
 * - SATNICA / DVA_DELA:
 *     payable = redovan + prekovremeni + praznik_rad + dve_masine
 *             + praznik_placeni + godisnji + slobodni
 *             + bolovanje_100 + 0.65 × bolovanje_65
 *   (množi se kasnije sa hour_rate)
 *
 * - FIKSNO:
 *     payable_extra = prekovremeni + praznik_rad + dve_masine
 *   (množi se sa fixed_extra_hour_rate; ostalo je pokriveno fixed_amount)
 *
 * @param {object} hours   sanitized sati za zaposlenog
 * @param {string} model   'fiksno' | 'dva_dela' | 'satnica'
 * @returns {{payableHours:number, breakdown:object}}
 */
export function computePayableHours(hours, model) {
  const h = {
    redovanRadSati:       NUM(hours.redovanRadSati),
    prekovremeniSati:     NUM(hours.prekovremeniSati),
    praznikRadSati:       NUM(hours.praznikRadSati),
    dveMasineSati:        NUM(hours.dveMasineSati),
    praznikPlaceniSati:   NUM(hours.praznikPlaceniSati),
    godisnjiSati:         NUM(hours.godisnjiSati),
    slobodniDaniSati:     NUM(hours.slobodniDaniSati),
    bolovanje100Sati:     NUM(hours.bolovanje100Sati),
    bolovanje65Sati:      NUM(hours.bolovanje65Sati),
  };

  let payable = 0;
  const breakdown = { ...h, factor65: BOLOVANJE_OBICNO_FACTOR };

  if (model === 'fiksno') {
    payable = h.prekovremeniSati + h.praznikRadSati + h.dveMasineSati;
    breakdown.mode = 'fiksno_extra_only';
  } else {
    /* dva_dela ili satnica — sve komponente sata se plaćaju po hour_rate */
    payable =
      h.redovanRadSati +
      h.prekovremeniSati +
      h.praznikRadSati +
      h.dveMasineSati +
      h.praznikPlaceniSati +
      h.godisnjiSati +
      h.slobodniDaniSati +
      h.bolovanje100Sati * BOLOVANJE_PUNO_FACTOR +
      h.bolovanje65Sati  * BOLOVANJE_OBICNO_FACTOR;
    breakdown.mode = 'weighted_full';
  }

  return { payableHours: round2(payable), breakdown };
}

/**
 * Glavni obračun — vraća kompletan rezultat za jedan red salary_payroll.
 *
 * @param {object} input
 *   @param {string} input.workType
 *   @param {object} input.terms                 — uslovi zarade (mapDbTerm shape)
 *   @param {object} input.hours                 — sati i odsustva agregirano
 *   @param {object} input.terrain               — { domestic, foreign } (count dana)
 *   @param {number} input.advanceAmount         — ako je već uplaćen prvi deo (RSD)
 *
 * @returns {{
 *   compensationModel:string,
 *   sanitizedHours:object,
 *   payableHours:number,
 *   ukupnaZarada:number,
 *   prviDeo:number,
 *   preostaloZaIsplatu:number,
 *   terrainRsd:number,
 *   terrainEur:number,
 *   breakdown:object,
 *   warnings:Array
 * }}
 */
export function computeEarnings(input) {
  const warnings = [];
  const workType = input.workType || 'ugovor';
  const terms = input.terms || {};
  const model = deriveCompensationModel(terms);

  if (!model) {
    pushWarning(warnings, 'no_compensation_model',
      'Aktivni uslovi zarade nemaju definisan tip zarade (compensation_model).');
  }

  const { sanitized, warnings: hoursWarn } = sanitizeHoursForWorkType(input.hours || {}, workType);
  warnings.push(...hoursWarn);

  const { payableHours, breakdown } = computePayableHours(sanitized, model);

  /* ── Komponente zarade ──────────────────────────────────────────── */
  let baseEarnings = 0;
  let extraEarnings = 0;
  let transportEarnings = 0;
  let prviDeo = 0;

  if (model === 'fiksno') {
    baseEarnings = NUM(terms.fixedAmount);
    extraEarnings = payableHours * NUM(terms.fixedExtraHourRate);
    /* Prevoz već uračunat u fixed_amount → 0 dodatno. fixed_transport_component
       je informativna komponenta i NE dodaje se. */
    transportEarnings = 0;
    prviDeo = NUM(input.advanceAmount);
  } else if (model === 'dva_dela') {
    baseEarnings = NUM(terms.firstPartAmount) + payableHours * NUM(terms.splitHourRate);
    transportEarnings = NUM(terms.splitTransportAmount);
    prviDeo = NUM(terms.firstPartAmount);
  } else if (model === 'satnica') {
    baseEarnings = payableHours * NUM(terms.hourlyRate);
    transportEarnings = NUM(terms.hourlyTransportAmount);
    prviDeo = NUM(input.advanceAmount);
  } else {
    /* model nepoznat → sve 0, već je upozoreno */
  }

  /* ── Teren ──────────────────────────────────────────────────────── */
  const terrainDomCount = NUM(input.terrain?.domestic);
  const terrainForCount = NUM(input.terrain?.foreign);
  const terrainRsd = terrainDomCount * NUM(terms.terrainDomesticRate);
  const terrainEur = terrainForCount * NUM(terms.terrainForeignRate);

  const ukupnaZarada = round2(baseEarnings + extraEarnings + transportEarnings + terrainRsd);
  const preostaloZaIsplatu = round2(ukupnaZarada - prviDeo);

  if (preostaloZaIsplatu < 0) {
    pushWarning(warnings, 'negative_remainder',
      `Preostalo za isplatu je negativno (${preostaloZaIsplatu.toFixed(2)} RSD) — prvi deo veći od ukupne zarade.`,
      { value: preostaloZaIsplatu }
    );
  }

  return {
    compensationModel: model || null,
    workType,
    sanitizedHours: sanitized,
    payableHours,
    ukupnaZarada,
    prviDeo: round2(prviDeo),
    preostaloZaIsplatu,
    terrainRsd: round2(terrainRsd),
    terrainEur: round2(terrainEur),
    breakdown: {
      ...breakdown,
      baseEarnings: round2(baseEarnings),
      extraEarnings: round2(extraEarnings),
      transportEarnings: round2(transportEarnings),
    },
    warnings,
  };
}

/* ── Pomoćne funkcije ──────────────────────────────────────────────── */

function round2(v) {
  if (v == null || isNaN(v)) return 0;
  return Math.round(Number(v) * 100) / 100;
}

/**
 * Računa fond sati za mesec: broj radnih dana (pon–pet) MINUS praznici koji
 * padaju na radne dane, sve × REGULAR_DAY_HOURS.
 *
 * @param {number} year
 * @param {number} month  1..12
 * @param {Set<string>|Array<string>} holidayDates — ymd stringovi 'YYYY-MM-DD'
 * @returns {{fondSati:number, radniDani:number, prazniciNaRadnim:number}}
 */
export function computeMonthlyFond(year, month, holidayDates) {
  const set = holidayDates instanceof Set
    ? holidayDates
    : new Set(Array.isArray(holidayDates) ? holidayDates : []);
  const daysInMonth = new Date(year, month, 0).getDate();
  let radniDani = 0;
  let prazniciNaRadnim = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(year, month - 1, d);
    const dow = dt.getDay(); // 0=Sun, 6=Sat
    if (dow === 0 || dow === 6) continue;
    radniDani += 1;
    const ymd = ymdLocal(dt);
    if (set.has(ymd)) prazniciNaRadnim += 1;
  }
  return {
    fondSati: (radniDani - prazniciNaRadnim) * REGULAR_DAY_HOURS,
    radniDani,
    prazniciNaRadnim,
  };
}

export function ymdLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
