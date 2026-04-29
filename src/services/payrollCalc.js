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

import { parseDateLocal } from '../lib/date.js';

/* ── Konstante (po Zakonu o radu RS, najmanji propisani koeficijenti) ── */
export const REGULAR_DAY_HOURS = 8;
export const BOLOVANJE_OBICNO_FACTOR = 0.65;       // 65% osnovice
export const BOLOVANJE_PUNO_FACTOR = 1.00;         // 100% osnovice
export const VALID_WORK_TYPES = ['ugovor', 'praksa', 'dualno', 'penzioner'];
export const VALID_COMPENSATION_MODELS = ['fiksno', 'dva_dela', 'satnica'];

const FULL_RIGHTS_WORK_TYPES = new Set(['ugovor']);

const NUM = (v) => (v == null || isNaN(v) ? 0 : Number(v));

/** Šifra odsustva iz API-ja / unosa (trim + lower). */
function normAbsCode(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim().toLowerCase();
  return s || null;
}

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

/** Ponedeljak–petak (lokalni kalendar). */
export function isWeekdayYmd(ymd) {
  if (!ymd || typeof ymd !== 'string') return false;
  const [y, m, d] = ymd.split('-').map(n => parseInt(n, 10));
  if (!y || !m || !d) return false;
  const dow = new Date(y, m - 1, d).getDay();
  return dow >= 1 && dow <= 5;
}

/**
 * Jedan dan iz work_hours mapiran u agregat za obračun.
 * @param {object} row  { hours, overtimeHours?, fieldHours?, twoMachineHours?, absenceCode?, absenceSubtype? }
 */
export function aggregateWorkHoursForMonth(year, month, rowsByYmd, holidayYmdSet) {
  const hol = holidayYmdSet instanceof Set
    ? holidayYmdSet
    : new Set(Array.isArray(holidayYmdSet) ? holidayYmdSet : []);
  const last = new Date(year, month, 0).getDate();
  const out = {
    redovanRadSati: 0,
    prekovremeniSati: 0,
    praznikRadSati: 0,
    praznikPlaceniSati: 0,
    godisnjiSati: 0,
    slobodniDaniSati: 0,
    bolovanje65Sati: 0,
    bolovanje100Sati: 0,
    dveMasineSati: 0,
  };

  for (let day = 1; day <= last; day++) {
    const mm = String(month).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    const ymd = `${year}-${mm}-${dd}`;
    const r = rowsByYmd?.get?.(ymd) || rowsByYmd?.[ymd] || null;
    const h = r ? NUM(r.hours) : 0;
    const ot = r ? NUM(r.overtimeHours ?? r.overtime_hours) : 0;
    const tm = r ? NUM(r.twoMachineHours ?? r.two_machine_hours) : 0;
    const abs = normAbsCode(r?.absenceCode || r?.absence_code);
    const sub = normAbsCode(r?.absenceSubtype || r?.absence_subtype);

    out.prekovremeniSati += ot;
    out.dveMasineSati += tm;

    const dow = (() => {
      const dt = parseDateLocal(ymd);
      return dt ? dt.getDay() : new Date(year, month - 1, day).getDay();
    })();
    const weekend = dow === 0 || dow === 6;
    const isHol = hol.has(ymd);

    if (weekend) {
      if (!abs && h > 0) {
        out.redovanRadSati += h;
        continue;
      }
      if (isHol && h > 0) {
        out.praznikRadSati += h;
        continue;
      }
      if (isHol) {
        if (abs === 'go') {
          out.godisnjiSati += REGULAR_DAY_HOURS;
        } else if (abs === 'bo') {
          if (sub === 'povreda_na_radu' || sub === 'odrzavanje_trudnoce') {
            out.bolovanje100Sati += REGULAR_DAY_HOURS;
          } else {
            out.bolovanje65Sati += REGULAR_DAY_HOURS;
          }
        } else if (abs === 'sp') {
          out.praznikPlaceniSati += REGULAR_DAY_HOURS;
        } else if (abs === 'sl') {
          out.slobodniDaniSati += REGULAR_DAY_HOURS;
        }
        continue;
      }
      if (abs === 'go') {
        out.godisnjiSati += REGULAR_DAY_HOURS;
      } else if (abs === 'bo') {
        if (sub === 'povreda_na_radu' || sub === 'odrzavanje_trudnoce') {
          out.bolovanje100Sati += REGULAR_DAY_HOURS;
        } else {
          out.bolovanje65Sati += REGULAR_DAY_HOURS;
        }
      } else if (abs === 'sp') {
        out.praznikPlaceniSati += REGULAR_DAY_HOURS;
      } else if (abs === 'sl') {
        out.slobodniDaniSati += REGULAR_DAY_HOURS;
      }
      continue;
    }

    /* Radni dan u smislu kalendara (pon–ned) koji nije vikend */
    if (isHol) {
      if (h > 0) {
        out.praznikRadSati += h;
        continue;
      }
      if (abs === 'go') {
        out.godisnjiSati += REGULAR_DAY_HOURS;
      } else if (abs === 'bo') {
        if (sub === 'povreda_na_radu' || sub === 'odrzavanje_trudnoce') {
          out.bolovanje100Sati += REGULAR_DAY_HOURS;
        } else {
          out.bolovanje65Sati += REGULAR_DAY_HOURS;
        }
      } else if (abs === 'sp') {
        out.praznikPlaceniSati += REGULAR_DAY_HOURS;
      } else if (abs === 'sl') {
        out.slobodniDaniSati += REGULAR_DAY_HOURS;
      } else if (abs === 'np' || abs === 'pr') {
        /* ne plaća se */
      } else {
        /* Državni praznik, bez rada — 8h plaćenog praznika */
        out.praznikPlaceniSati += REGULAR_DAY_HOURS;
      }
      continue;
    }

    /* Običan radni dan */
    if (abs === 'go') {
      out.godisnjiSati += REGULAR_DAY_HOURS;
    } else if (abs === 'bo') {
      if (sub === 'povreda_na_radu' || sub === 'odrzavanje_trudnoce') {
        out.bolovanje100Sati += REGULAR_DAY_HOURS;
      } else {
        out.bolovanje65Sati += REGULAR_DAY_HOURS;
      }
    } else if (abs === 'sp') {
      out.praznikPlaceniSati += REGULAR_DAY_HOURS;
    } else if (abs === 'sl') {
      out.slobodniDaniSati += REGULAR_DAY_HOURS;
    } else if (abs === 'np' || abs === 'pr') {
      /* 0 */
    } else {
      out.redovanRadSati += h;
    }
  }

  return out;
}

/**
 * Zbir za „Redovni” red u mesečnom gridu (vizuelno: puni sati za GO / praznik / bolovanje na radnim danima).
 */
export function gridRedovniSumUnitsForMonth(year, month, rowsByYmd, holidayYmdSet) {
  const agg = aggregateWorkHoursForMonth(year, month, rowsByYmd, holidayYmdSet);
  return agg.redovanRadSati
    + agg.praznikPlaceniSati
    + agg.godisnjiSati
    + agg.slobodniDaniSati
    + agg.bolovanje65Sati
    + agg.bolovanje100Sati
    + agg.praznikRadSati;
}

/**
 * Doprinos jednog dana zbiru „Redovni” reda u mesečnom gridu.
 * Ovo je prikazni zbir: GO / bolovanje / plaćeno odsustvo / državni praznik
 * prikazuju 8h bez obzira na work_type. Obračun zarade prava se primenjuje
 * odvojeno kroz aggregateWorkHoursForMonth + sanitizeHoursForWorkType.
 */
export function gridRedovniUnitsOneDay(ymd, row, holidayYmdSet) {
  const hol = holidayYmdSet instanceof Set
    ? holidayYmdSet
    : new Set(Array.isArray(holidayYmdSet) ? holidayYmdSet : []);
  const eff = row || {};
  const h = NUM(eff.hours);
  const abs = normAbsCode(eff.absence_code || eff.absenceCode);
  const sub = normAbsCode(eff.absence_subtype || eff.absenceSubtype);

  const [yStr, mStr, dStr] = (ymd || '').split('-');
  const y = parseInt(yStr, 10);
  const mo = parseInt(mStr, 10);
  const d = parseInt(dStr, 10);
  if (!y || !mo || !d) return 0;
  const dt = parseDateLocal(ymd);
  const dow = dt ? dt.getDay() : new Date(y, mo - 1, d).getDay();
  const weekend = dow === 0 || dow === 6;
  const isHol = hol.has(ymd);

  if (weekend) {
    if (!abs && h > 0) return h;
    if (isHol && h > 0) return h;
    if (isHol) {
      if (abs === 'go') return REGULAR_DAY_HOURS;
      if (abs === 'bo') return REGULAR_DAY_HOURS;
      if (abs === 'sp') return REGULAR_DAY_HOURS;
      if (abs === 'sl') return REGULAR_DAY_HOURS;
      if (abs === 'np' || abs === 'pr') return 0;
      return 0;
    }
    if (abs === 'go' || abs === 'sp' || abs === 'sl' || abs === 'bo') {
      return REGULAR_DAY_HOURS;
    }
    if (abs === 'np' || abs === 'pr') return 0;
    return 0;
  }
  if (isHol) {
    if (h > 0) return h;
    if (abs === 'go') return REGULAR_DAY_HOURS;
    if (abs === 'bo') return REGULAR_DAY_HOURS;
    if (abs === 'sp') return REGULAR_DAY_HOURS;
    if (abs === 'sl') return REGULAR_DAY_HOURS;
    if (abs === 'np' || abs === 'pr') return 0;
    return REGULAR_DAY_HOURS;
  }
  if (abs === 'go' || abs === 'sp' || abs === 'sl' || abs === 'bo') {
    return REGULAR_DAY_HOURS;
  }
  if (abs === 'np' || abs === 'pr') return 0;
  return h;
}

export function ymdLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
