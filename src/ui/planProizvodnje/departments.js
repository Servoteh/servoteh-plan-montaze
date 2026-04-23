/**
 * Single source of truth za tab-odeljenja iznad dropdown-a mašina
 * u modulu Planiranje proizvodnje → tab „Po mašini".
 *
 * Mapiranje BigTehn naziva odeljenja (`bigtehn_departments_cache.name`) u
 * user-facing label radi se preko `matchPatterns` (case-insensitive, bez
 * dijakritike, substring). Stabilno je na sitne razlike u nazivima
 * (npr. „Glodanje", „GLODANJE - CNC", „Glodaca grupa"). Sve što ne
 * matchuje ni jedan pattern pada u `ostalo` — safety bucket, da nijedna
 * mašina ne nestane iz UI-a.
 *
 * Ako se pojavi novo odeljenje koje treba u jednu od postojećih kategorija,
 * dovoljno je dopisati pattern u odgovarajući `matchPatterns`.
 */

export const DEPARTMENTS = [
  { slug: 'sve',         label: 'Sve',                 matchPatterns: null /* prikazuje sve */ },
  { slug: 'glodanje',    label: 'Glodanje',            matchPatterns: ['glodan'] },
  { slug: 'struganje',   label: 'Struganje',           matchPatterns: ['strug'] },
  { slug: 'borverci',    label: 'Borverci',            matchPatterns: ['borverc', 'borver'] },
  { slug: 'azistiranje', label: 'Ažistiranje',         matchPatterns: ['azistir', 'ažistir'] },
  { slug: 'secenje',     label: 'Sečenje',             matchPatterns: ['secen', 'sečen'] },
  { slug: 'bravarsko',   label: 'Bravarsko',           matchPatterns: ['bravar'] },
  { slug: 'farbanje',    label: 'Farbanje',            matchPatterns: ['farban'] },
  { slug: 'povrsinska',  label: 'Površinska zaštita',  matchPatterns: ['povrsinsk', 'površinsk', 'zastit', 'zaštit'] },
  { slug: 'ostalo',      label: 'Ostalo',              matchPatterns: null /* fallback bucket */ },
];

const stripDiacritics = (s) => (s || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().trim();

/**
 * Vraća slug odeljenja za datu mašinu na osnovu departmentName iz baze.
 * Ako nijedan pattern ne matchuje (ili je naziv prazan/null) → 'ostalo'.
 *
 * @param {string|null|undefined} departmentName  npr. "Glodanje", "Sečenje"
 * @returns {string}  slug iz `DEPARTMENTS` (npr. 'glodanje'); nikad 'sve'
 */
export function resolveDepartmentSlug(departmentName) {
  const n = stripDiacritics(departmentName);
  if (!n) return 'ostalo';
  for (const dept of DEPARTMENTS) {
    if (!dept.matchPatterns) continue;              /* preskoči 'sve' i 'ostalo' */
    for (const p of dept.matchPatterns) {
      if (n.includes(stripDiacritics(p))) return dept.slug;
    }
  }
  return 'ostalo';
}
