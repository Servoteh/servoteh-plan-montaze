/**
 * Excel / PDF izvoz za tabelu praćenja — isti model kao RPC get_predmet_pracenje_izvestaj.
 */

import { loadXlsx } from '../lib/xlsx.js';
import { loadPdfLibs } from '../lib/pdf.js';
import { getBigtehnDrawingSignedUrl } from './drawings.js';
import { logPracenjeExport } from './pracenjeProizvodnje.js';

function filterRows(rows, filter) {
  if (!Array.isArray(rows)) return [];
  if (filter === 'sve') return rows;
  return rows.filter((r) => {
    const s = r.statusi || {};
    switch (filter) {
      case 'nije_kompletirano': return !!s.nije_kompletirano;
      case 'nema_tp': return !!s.nema_tp;
      case 'nema_crtez': return !!s.nema_crtez;
      case 'nema_zavrsnu_kontrolu': return !!s.nema_zavrsnu_kontrolu;
      case 'kasni': return !!s.kasni;
      case 'ima_napomenu': return String(r.korisnicka_napomena || r.sistemska_napomena || '').trim().length > 0;
      default: return true;
    }
  });
}

function maxOpSlots(rows) {
  let m = 0;
  for (const r of rows || []) {
    if (Array.isArray(r.operations)) m = Math.max(m, r.operations.length);
  }
  return m;
}

function safeNamePart(s) {
  return String(s || 'predmet').replace(/[^\w\-]+/g, '_').slice(0, 40);
}

function buildBaseFileName(state) {
  const ap = state.aktivniPredmetiState || {};
  const pred = ap.izvestaj?.predmet || {};
  const hid = ap.headerPredmet || {};
  const broj = pred.broj_predmeta || hid.broj_predmeta || 'predmet';
  const root = ap.izvestaj?.root;
  const scope = root?.node_id != null ? `root-${root.node_id}` : 'ceo-predmet';
  const d = new Date().toISOString().slice(0, 10);
  return `pracenje-proizvodnje_${safeNamePart(broj)}_${safeNamePart(scope)}_${d}`;
}

async function resolveDrawingUrls(rows) {
  const nos = new Set();
  for (const r of rows) {
    if (r.crtez_drawing_no) nos.add(String(r.crtez_drawing_no));
    if (r.sklop_drawing_no) nos.add(String(r.sklop_drawing_no));
  }
  const map = new Map();
  for (const n of nos) {
    try {
      const u = await getBigtehnDrawingSignedUrl(n);
      if (u) map.set(n, u);
    } catch {
      /* ostavi bez linka */
    }
  }
  return map;
}

export async function exportPracenjeIzvestajExcel(state) {
  const XLSX = await loadXlsx();
  const ap = state.aktivniPredmetiState || {};
  const data = ap.izvestaj;
  if (!data?.rows) throw new Error('Prvo učitaj izveštaj (Osveži).');
  const rows = filterRows(data.rows, ap.izvestajFilter || 'sve');
  const nSlots = maxOpSlots(rows);
  const urlMap = await resolveDrawingUrls(rows);

  const meta = [
    ['Praćenje proizvodnje — izveštaj'],
    ['Predmet', data.predmet?.broj_predmeta || '', data.predmet?.naziv_predmeta || ''],
    ['Komitent', data.predmet?.komitent || ''],
    ['Rok završetka', data.predmet?.rok_zavrsetka != null ? String(data.predmet.rok_zavrsetka) : ''],
    ['Opseg', data.root?.naziv || 'Ceo predmet'],
    ['Lot', String(data.lot_qty ?? ap.izvestajLotQty ?? 12)],
    ['Generisano', data.generated_at != null ? String(data.generated_at) : new Date().toISOString()],
    ['Filter', ap.izvestajFilter || 'sve'],
    [],
  ];

  const opHeaders = [];
  for (let i = 0; i < nSlots; i += 1) {
    opHeaders.push(`Operacija ${i + 1}`, `Kol. ${i + 1}`);
  }
  const headers = [
    'Nivo', 'Naziv', 'Broj crteža', 'Sklopni crtež', 'RN', 'Lansirano', 'Završeno', 'Za lot',
    'Datum lans. TP', 'Datum izrade', 'Maš. obr.', 'Povr. zašt.', 'Materijal', 'Dimenzije',
    'Napomena', 'Status', 'Završna kol.', ...opHeaders,
  ];

  const aoa = [...meta, headers];
  const merges = [];

  for (const r of rows) {
    const st = r.statusi || {};
    const statusTxt = [
      st.kasni && 'Kasni',
      st.nema_tp && 'Nema TP',
      st.nema_crtez && 'Nema crtež',
      st.nema_zavrsnu_kontrolu && 'Nema ZK',
      st.nije_kompletirano && 'Nije kompl.',
      st.nema_rn && 'Nema RN',
    ].filter(Boolean).join(', ') || 'OK';

    let finalQty = '';
    const ops = r.operations || [];
    for (let i = ops.length - 1; i >= 0; i -= 1) {
      if (ops[i]?.is_final_control) {
        finalQty = `${ops[i].completed_qty ?? ''}/${ops[i].planned_qty ?? ''}`;
        break;
      }
    }

    const note = [r.sistemska_napomena, r.korisnicka_napomena].filter(Boolean).join(' | ');

    const row = [
      Number(r.level ?? 0),
      r.naziv_pozicije || '',
      r.broj_crteza || '',
      r.broj_sklopnog_crteza || '',
      r.rn_broj || '',
      r.lansirana_kolicina ?? '',
      r.zavrsena_kolicina ?? '',
      r.required_for_lot ?? 'N/A',
      r.datum_lansiranja_tp || '',
      r.datum_izrade || '',
      r.masinska_obrada_status || '',
      r.povrsinska_zastita_status || '',
      r.materijal || '',
      r.dimenzije || '',
      note,
      statusTxt,
      finalQty,
    ];

    for (let i = 0; i < nSlots; i += 1) {
      const o = ops[i];
      if (!o) {
        row.push('', '');
      } else {
        row.push(String(o.naziv ?? ''), `${o.completed_qty ?? ''}/${o.planned_qty ?? ''}`);
      }
    }
    aoa.push(row);
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const metaRows = meta.length;
  if (!ws['!cols']) ws['!cols'] = [];
  headers.forEach((_, i) => {
    ws['!cols'][i] = { wch: i === 1 ? 36 : 14 };
  });

  /* Hyperlinkovi za crteže (redovi podataka počinju posle meta + header) */
  const drawCol = 2;
  const sklopCol = 3;
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const excelRow = metaRows + 2 + i; /* 1-based za sheet */
    const cr = r.crtez_drawing_no ? urlMap.get(String(r.crtez_drawing_no)) : null;
    if (cr) {
      const addr = XLSX.utils.encode_cell({ r: excelRow - 1, c: drawCol });
      if (ws[addr]) ws[addr].l = { Target: cr, Tooltip: 'Crtež' };
    }
    const sr = r.sklop_drawing_no ? urlMap.get(String(r.sklop_drawing_no)) : null;
    if (sr) {
      const addr = XLSX.utils.encode_cell({ r: excelRow - 1, c: sklopCol });
      if (ws[addr]) ws[addr].l = { Target: sr, Tooltip: 'Sklopni crtež' };
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Praćenje');
  const fileName = `${buildBaseFileName(state)}.xlsx`;
  XLSX.writeFile(wb, fileName);

  void logPracenjeExport({
    tab: 'tabela_pracenja_excel',
    predmetItemId: ap.selectedItemId,
    extra: { file: fileName, rows: rows.length },
  });
}

export async function exportPracenjeIzvestajPdf(state) {
  const { jsPDF } = await loadPdfLibs();
  const ap = state.aktivniPredmetiState || {};
  const data = ap.izvestaj;
  if (!data?.rows) throw new Error('Prvo učitaj izveštaj (Osveži).');
  const rows = filterRows(data.rows, ap.izvestajFilter || 'sve');
  const urlMap = await resolveDrawingUrls(rows);

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a3' });
  const pageW = doc.internal.pageSize.getWidth();
  const m = 10;
  let y = m;
  const line = 5;
  doc.setFontSize(14);
  doc.text('Praćenje proizvodnje', m, y);
  y += line + 2;
  doc.setFontSize(10);
  doc.text(`Predmet: ${data.predmet?.broj_predmeta || ''} ${data.predmet?.naziv_predmeta || ''}`, m, y); y += line;
  doc.text(`Komitent: ${data.predmet?.komitent || ''}`, m, y); y += line;
  doc.text(`Opseg: ${data.root?.naziv || 'Ceo predmet'}`, m, y); y += line;
  doc.text(`Lot: ${data.lot_qty ?? ap.izvestajLotQty ?? 12}`, m, y); y += line;
  doc.text(`Generisano: ${data.generated_at != null ? String(data.generated_at) : new Date().toISOString()}`, m, y);
  y += line + 4;

  const colW = (pageW - 2 * m) / 10;
  const headers = ['Pozicija', 'Crtež', 'RN', 'Lans.', 'Zavr.', 'Za lot', 'Datumi', 'Mat./dim.', 'Napomena', 'Operacije'];
  doc.setFont(undefined, 'bold');
  headers.forEach((h, i) => doc.text(h, m + i * colW, y));
  y += line;
  doc.setFont(undefined, 'normal');

  const addRow = (r) => {
    if (y > doc.internal.pageSize.getHeight() - 20) {
      doc.addPage();
      y = m;
    }
    const drawL = r.crtez_drawing_no ? urlMap.get(String(r.crtez_drawing_no)) : null;
    const poz = `${'  '.repeat(Number(r.level || 0))}${(r.naziv_pozicije || '').slice(0, 42)}`;
    doc.text(poz, m, y);
    doc.text(String(r.broj_crteza || '—').slice(0, 14), m + colW, y);
    doc.text(String(r.rn_broj || '').slice(0, 12), m + 2 * colW, y);
    doc.text(String(r.lansirana_kolicina ?? '—'), m + 3 * colW, y);
    doc.text(String(r.zavrsena_kolicina ?? '—'), m + 4 * colW, y);
    doc.text(String(r.required_for_lot ?? 'N/A'), m + 5 * colW, y);
    doc.text(`${r.datum_lansiranja_tp || '—'} / ${r.datum_izrade || '—'}`, m + 6 * colW, y);
    doc.text(`${(r.materijal || '').slice(0, 10)} ${(r.dimenzije || '').slice(0, 10)}`, m + 7 * colW, y);
    doc.text(`${(r.korisnicka_napomena || r.sistemska_napomena || '').slice(0, 28)}`, m + 8 * colW, y);
    const os = (r.operations || []).slice(0, 4).map(o => `${o.naziv}:${o.completed_qty}/${o.planned_qty}`).join('; ');
    doc.text(os.slice(0, 36), m + 9 * colW, y);
    if (drawL) {
      doc.link(m + colW, y - 4, colW, line, { url: drawL });
    }
    y += line;
  };

  for (const r of rows) {
    addRow(r);
  }

  /* Detalji operacija — druga sekcija */
  doc.addPage();
  y = m;
  doc.setFontSize(12);
  doc.text('Detalj operacija po pozicijama', m, y);
  y += line + 2;
  doc.setFontSize(9);
  for (const r of rows) {
    const ops = r.operations || [];
    if (!ops.length) continue;
    if (y > doc.internal.pageSize.getHeight() - 24) {
      doc.addPage();
      y = m;
    }
    doc.setFont(undefined, 'bold');
    doc.text(`${r.rn_broj || r.node_id} — ${(r.naziv_pozicije || '').slice(0, 80)}`, m, y);
    y += line;
    doc.setFont(undefined, 'normal');
    for (const o of ops) {
      if (y > doc.internal.pageSize.getHeight() - 10) {
        doc.addPage();
        y = m;
      }
      doc.text(
        `  ${o.redosled ?? ''}. ${String(o.naziv || '').slice(0, 40)} | ${o.masina || ''} | ${o.completed_qty ?? ''}/${o.planned_qty ?? ''}`,
        m,
        y,
      );
      y += line - 1;
    }
    y += 2;
  }

  const fileName = `${buildBaseFileName(state)}.pdf`;
  doc.save(fileName);

  void logPracenjeExport({
    tab: 'tabela_pracenja_pdf',
    predmetItemId: ap.selectedItemId,
    extra: { file: fileName, rows: rows.length },
  });
}
