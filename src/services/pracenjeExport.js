/**
 * Excel export za Praćenje proizvodnje.
 *
 * Koristi postojeći SheetJS lazy loader (`src/lib/xlsx.js`), bez nove zavisnosti.
 */

import { loadXlsx } from '../lib/xlsx.js';
import { logPracenjeExport } from './pracenjeProizvodnje.js';

export async function exportTab1ToExcel(rnId, payload) {
  const XLSX = await loadXlsx();
  const header = payload?.header || {};
  const positions = flattenPositions(payload?.positions || []);
  const operations = positions.flatMap(p => (p.operations || []).map(op => ({
    Pozicija: p.sifra_pozicije || p.id,
    NazivPozicije: p.naziv || '',
    Operacija: op.operacija_kod || '',
    NazivOperacije: op.naziv || '',
    WorkCenter: op.work_center || '',
    Planirano: op.planirano_komada ?? '',
    Prijavljeno: op.prijavljeno_komada ?? '',
    Status: op.status || '',
    PoslednjaPrijava: op.poslednja_prijava_at || '',
  })));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Kupac', header.kupac || ''],
    ['Projekat', header.projekat_naziv || header.projekat_id || ''],
    ['RN', header.rn_broj || ''],
    ['Datum isporuke', header.datum_isporuke || ''],
    ['Koordinator', header.koordinator || ''],
    ['Napomena', header.napomena || ''],
  ]), 'RN');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(positions.map(p => ({
    Nivo: p.level,
    Pozicija: p.sifra_pozicije || p.id,
    Naziv: p.naziv || '',
    KolicinaPlan: p.kolicina_plan ?? '',
    ProgressPct: p.progress_pct ?? '',
    ParentId: p.parent_id || '',
  }))), 'Pozicije');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(operations), 'Operacije');

  const fileName = buildFileName(header.rn_broj, 'po_pozicijama');
  XLSX.writeFile(wb, fileName);
  void logPracenjeExport({ rnId, tab: 'po_pozicijama', rnBroj: header.rn_broj });
}

export async function exportTab2ToExcel(rnId, payload) {
  const XLSX = await loadXlsx();
  const header = payload?.header || {};
  const activities = payload?.activities || [];
  const dashboard = payload?.dashboard || {};
  const wb = XLSX.utils.book_new();

  const planRows = [
    ['Kupac', header.kupac || '', '', 'RN', header.rn_broj || ''],
    ['Mašina/linija', header.masina_linija || '', '', 'Datum isporuke', header.datum_isporuke || ''],
    ['Koordinator', header.koordinator || '', '', 'Napomena', header.napomena || ''],
    [],
    ['RB', 'Odeljenje', 'Aktivnost', 'Br. TP', 'Količina', 'Plan. početak', 'Plan. završetak', 'Odgovoran', 'Zavisi od', 'Status', 'Prioritet', 'Rizik', 'Rezerva', 'Kasni'],
    ...activities.map(a => [
      a.rb ?? '',
      a.odeljenje || a.odeljenje_naziv || '',
      a.naziv_aktivnosti || '',
      a.broj_tp || '',
      a.kolicina_text || '',
      a.planirani_pocetak || '',
      a.planirani_zavrsetak || '',
      a.odgovoran || a.odgovoran_label || '',
      a.zavisi_od || a.zavisi_od_text || '',
      a.efektivni_status || a.status || '',
      a.prioritet || '',
      a.rizik_napomena || '',
      a.rezerva_dani ?? '',
      a.kasni ? 'DA' : 'NE',
    ]),
  ];
  const wsPlan = XLSX.utils.aoa_to_sheet(planRows);
  wsPlan['!cols'] = [
    { wch: 6 }, { wch: 22 }, { wch: 42 }, { wch: 14 }, { wch: 14 },
    { wch: 14 }, { wch: 14 }, { wch: 20 }, { wch: 26 }, { wch: 14 },
    { wch: 12 }, { wch: 32 }, { wch: 10 }, { wch: 8 },
  ];
  XLSX.utils.book_append_sheet(wb, wsPlan, 'Plan po odeljenjima');

  const pregledRows = [
    ['Odeljenje', 'Ukupno', 'Završeno', 'U toku', 'Blokirano', 'Nije krenulo', 'Najkasniji planirani završetak'],
    ...(dashboard.po_odeljenjima || []).map(r => [
      r.odeljenje || '',
      r.ukupno ?? 0,
      r.zavrseno ?? 0,
      r.u_toku ?? 0,
      r.blokirano ?? 0,
      r.nije_krenulo ?? 0,
      r.najkasniji_planirani_zavrsetak || '',
    ]),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(pregledRows), 'Pregled');

  const fileName = buildFileName(header.rn_broj, 'operativni_plan');
  XLSX.writeFile(wb, fileName);
  void logPracenjeExport({ rnId, tab: 'operativni_plan', rnBroj: header.rn_broj });
}

function flattenPositions(positions, level = 0) {
  const nodes = new Map();
  positions.forEach(p => nodes.set(p.id, { ...p, children: [] }));
  const roots = [];
  nodes.forEach(n => {
    if (n.parent_id && nodes.has(n.parent_id)) nodes.get(n.parent_id).children.push(n);
    else roots.push(n);
  });
  const out = [];
  const walk = (node, depth) => {
    out.push({ ...node, level: depth });
    node.children.forEach(ch => walk(ch, depth + 1));
  };
  roots.forEach(r => walk(r, level));
  return out;
}

function buildFileName(rnBroj, tab) {
  const rn = String(rnBroj || 'rn').replace(/[^a-zA-Z0-9_-]+/g, '_');
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `pracenje_${rn}_${tab}_${date}.xlsx`;
}
