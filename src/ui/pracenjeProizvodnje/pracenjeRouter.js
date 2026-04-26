/**
 * URL stanje za Praćenje proizvodnje: ?rn= | ?predmet= | ?root= | lista (bez query).
 */

export const PREDMET_TAB_IDS = ['stablo', 'tabela_pracenja'];

export function getPracenjeUrlState() {
  if (typeof window === 'undefined') {
    return { rn: null, predmet: null, rootRn: null };
  }
  const p = new URLSearchParams(window.location.search);
  const rn = p.get('rn');
  const pred = p.get('predmet');
  const root = p.get('root');
  const predNum = pred != null && /^\d+$/.test(String(pred).trim()) ? Number(pred) : null;
  const rootNum = root != null && /^\d+$/.test(String(root).trim()) ? Number(root) : null;
  return {
    rn: rn && String(rn).trim() ? String(rn).trim() : null,
    predmet: predNum != null && Number.isFinite(predNum) ? predNum : null,
    rootRn: rootNum != null && Number.isFinite(rootNum) && rootNum > 0 ? rootNum : null,
  };
}

/** Tabovi u kontekstu predmeta (#tab=stablo | tabela_pracenja). */
export function predmetTabFromHash() {
  if (typeof window === 'undefined') return 'stablo';
  const raw = new URLSearchParams((window.location.hash || '').replace(/^#/, '')).get('tab');
  return PREDMET_TAB_IDS.includes(raw) ? raw : 'stablo';
}

/** replaceState: ?predmet= + opcioni ?root= + #tab= (bez novog history koraka). */
export function replacePracenjePredmetUrl({ predmetItemId, rootRnId = undefined, hashTab = undefined } = {}) {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  params.delete('rn');
  if (predmetItemId != null) params.set('predmet', String(predmetItemId));
  if (rootRnId !== undefined) {
    if (rootRnId != null && rootRnId !== '' && Number(rootRnId) > 0) {
      params.set('root', String(Math.floor(Number(rootRnId))));
    } else {
      params.delete('root');
    }
  }
  const hash = hashTab != null
    ? `#tab=${hashTab}`
    : (window.location.hash || '');
  const qs = params.toString();
  history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${hash}`);
}
