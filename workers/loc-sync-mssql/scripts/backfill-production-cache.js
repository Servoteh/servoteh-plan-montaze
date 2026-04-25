/**
 * Jednokratni backfill za modul Planiranje proizvodnje.
 *
 * MSSQL BigTehn:
 *   - dbo.tRN           -> public.bigtehn_work_orders_cache
 *   - dbo.tStavkeRN     -> public.bigtehn_work_order_lines_cache
 *   - dbo.tTehPostupak  -> public.bigtehn_tech_routing_cache
 *
 * Periodični eksterni Bridge može imati vremenski prozor (npr. 30 dana).
 * Ova skripta namerno čita po ID-u bez date filtera i upsertuje cache tabele.
 *
 * Primeri poziva iz `workers/loc-sync-mssql`:
 *   node scripts/backfill-production-cache.js --dry-run
 *   node scripts/backfill-production-cache.js --scope=open
 *   node scripts/backfill-production-cache.js --scope=all --batch=1000
 *   node scripts/backfill-production-cache.js --tables=lines,tech --scope=all
 */

import 'dotenv/config';
import sql from 'mssql';
import { createClient } from '@supabase/supabase-js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger(level = 'info', service = 'production-backfill') {
  const min = LEVELS[level] ?? LEVELS.info;
  const log = (lvl, msg, extra) => {
    if (LEVELS[lvl] < min) return;
    const entry = {
      ts: new Date().toISOString(),
      level: lvl,
      service,
      msg,
      ...(extra && typeof extra === 'object' ? extra : {}),
    };
    const line = JSON.stringify(entry);
    if (lvl === 'error' || lvl === 'warn') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  };
  return {
    debug: (msg, extra) => log('debug', msg, extra),
    info: (msg, extra) => log('info', msg, extra),
    warn: (msg, extra) => log('warn', msg, extra),
    error: (msg, extra) => log('error', msg, extra),
  };
}

const logger = createLogger(process.env.LOG_LEVEL?.toLowerCase() || 'info');

function requiredEnv(name) {
  const v = process.env[name];
  if (!v || v.trim() === '') throw new Error(`Missing required env var: ${name}`);
  return v.trim();
}

function optionalEnv(name, fallback) {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : fallback;
}

function intEnv(name, fallback) {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function boolEnv(name, fallback) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  return String(v).toLowerCase() === 'true' || v === '1';
}

const TABLE_ORDER = ['work-orders', 'lines', 'tech'];

function parseArgs(argv) {
  const out = {
    scope: 'open',
    tables: TABLE_ORDER,
    dryRun: false,
    batch: 500,
    limit: null,
  };

  for (const a of argv.slice(2)) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--scope=')) {
      const scope = a.slice('--scope='.length).trim().toLowerCase();
      if (scope === 'open' || scope === 'all') out.scope = scope;
      else throw new Error(`Invalid --scope=${scope}; expected open|all`);
    } else if (a.startsWith('--tables=')) {
      const raw = a.slice('--tables='.length).trim();
      const tables = raw.split(',').map(s => s.trim()).filter(Boolean);
      const unknown = tables.filter(t => !TABLE_ORDER.includes(t));
      if (unknown.length) {
        throw new Error(`Invalid --tables value(s): ${unknown.join(', ')}; expected ${TABLE_ORDER.join(',')}`);
      }
      out.tables = TABLE_ORDER.filter(t => tables.includes(t));
    } else if (a.startsWith('--batch=')) {
      const n = parseInt(a.slice('--batch='.length), 10);
      if (Number.isFinite(n) && n > 0) out.batch = n;
    } else if (a.startsWith('--limit=')) {
      const n = parseInt(a.slice('--limit='.length), 10);
      if (Number.isFinite(n) && n > 0) out.limit = n;
    } else if (a === '-h' || a === '--help') {
      out.help = true;
    } else {
      logger.warn('unknown flag ignored', { flag: a });
    }
  }

  return out;
}

function printHelp() {
  const lines = [
    'Usage: node scripts/backfill-production-cache.js [options]',
    '',
    'Options:',
    '  --scope=open       (default) sync samo RN-ove gde tRN.StatusRN nije true',
    '  --scope=all        sync bez vremenskog/status filtera',
    '  --tables=a,b       work-orders,lines,tech (default: all three)',
    '  --batch=500        veličina batch-a za select/upsert (default 500)',
    '  --limit=N          ograniči ukupan broj redova po tabeli (test)',
    '  --dry-run          samo broji/čita — ne upsertuje u Supabase',
    '  -h, --help         prikaži help',
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

const iso = v => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
const numOr = (v, def = 0) => (Number.isFinite(Number(v)) ? Number(v) : def);
const nullableNum = v => (v == null || v === '' ? null : numOr(v, null));
const textOrNull = v => (v == null ? null : String(v));
const boolOr = (v, def = false) => (v == null ? def : Boolean(v));

function mapWorkOrderRow(r) {
  return {
    id: Number(r.IDRN),
    item_id: nullableNum(r.IDPredmet),
    customer_id: nullableNum(r.BBIDKomitent),
    ident_broj: String(r.IdentBroj ?? '').trim(),
    varijanta: numOr(r.Varijanta),
    broj_crteza: r.BrojCrteza == null ? null : String(r.BrojCrteza).trim(),
    naziv_dela: textOrNull(r.NazivDela),
    materijal: textOrNull(r.Materijal),
    dimenzija_materijala: textOrNull(r.DimenzijaMaterijala),
    jedinica_mere: textOrNull(r.JM),
    komada: numOr(r.Komada),
    tezina_neobr: numOr(r.TezinaNeobrDela),
    tezina_obr: numOr(r.TezinaObrDela),
    status_rn: boolOr(r.StatusRN),
    zakljucano: boolOr(r.Zakljucano),
    revizija: textOrNull(r.Revizija),
    quality_type_id: nullableNum(r.IDVrstaKvaliteta),
    handover_status_id: nullableNum(r.IDStatusPrimopredaje),
    napomena: textOrNull(r.Napomena),
    rok_izrade: iso(r.RokIzrade),
    datum_unosa: iso(r.DatumUnosa),
    created_at: iso(r.DIVUnosaRN),
    modified_at: iso(r.DIVIspravkeRN),
    author_worker_id: nullableNum(r.SifraRadnika),
    synced_at: new Date().toISOString(),
  };
}

function mapLineRow(r) {
  return {
    id: Number(r.IDStavkeRN),
    work_order_id: Number(r.IDRN),
    operacija: numOr(r.Operacija),
    machine_code: textOrNull(r.RJgrupaRC),
    opis_rada: textOrNull(r.OpisRada),
    alat_pribor: textOrNull(r.AlatPribor),
    tpz: numOr(r.Tpz),
    tk: numOr(r.Tk),
    tezina_to: numOr(r.TezinaTO),
    author_worker_id: nullableNum(r.SifraRadnika),
    created_at: iso(r.DIVUnosa),
    modified_at: iso(r.DIVIspravke),
    prioritet: numOr(r.Prioritet),
    synced_at: new Date().toISOString(),
  };
}

function mapTechRow(r) {
  return {
    id: Number(r.IDPostupka),
    work_order_id: nullableNum(r.IDRN),
    item_id: nullableNum(r.IDPredmet),
    worker_id: nullableNum(r.SifraRadnika),
    quality_type_id: nullableNum(r.IDVrstaKvaliteta),
    operacija: numOr(r.Operacija),
    machine_code: textOrNull(r.RJgrupaRC),
    komada: numOr(r.Komada),
    prn_timer_seconds: nullableNum(r.PrnTimer),
    started_at: iso(r.DatumIVremeUnosa),
    finished_at: iso(r.DatumIVremeZavrsetka),
    is_completed: boolOr(r.ZavrsenPostupak),
    ident_broj: textOrNull(r.IdentBroj),
    varijanta: numOr(r.Varijanta),
    toznaka: textOrNull(r.Toznaka),
    potpis: textOrNull(r.Potpis),
    napomena: textOrNull(r.Napomena),
    dorada_operacije: numOr(r.DoradaOperacije),
    synced_at: new Date().toISOString(),
  };
}

const SOURCES = {
  'work-orders': {
    target: 'bigtehn_work_orders_cache',
    idCol: 'IDRN',
    from: 'dbo.tRN src',
    selectCols: [
      'src.IDRN',
      'src.IDPredmet',
      'src.BBIDKomitent',
      'src.IdentBroj',
      'src.Varijanta',
      'src.BrojCrteza',
      'src.NazivDela',
      'src.Materijal',
      'src.DimenzijaMaterijala',
      'src.JM',
      'src.Komada',
      'src.TezinaNeobrDela',
      'src.TezinaObrDela',
      'src.StatusRN',
      'src.Zakljucano',
      'src.Revizija',
      'src.IDVrstaKvaliteta',
      'src.IDStatusPrimopredaje',
      'CAST(src.Napomena AS NVARCHAR(MAX)) AS Napomena',
      'src.RokIzrade',
      'src.DatumUnosa',
      'src.DIVUnosaRN',
      'src.DIVIspravkeRN',
      'src.SifraRadnika',
    ],
    openWhere: 'ISNULL(src.StatusRN, 0) = 0',
    map: mapWorkOrderRow,
  },
  lines: {
    target: 'bigtehn_work_order_lines_cache',
    idCol: 'IDStavkeRN',
    from: 'dbo.tStavkeRN src',
    selectCols: [
      'src.IDStavkeRN',
      'src.IDRN',
      'src.Operacija',
      'src.RJgrupaRC',
      'CAST(src.OpisRada AS NVARCHAR(MAX)) AS OpisRada',
      'src.AlatPribor',
      'src.Tpz',
      'src.Tk',
      'src.TezinaTO',
      'src.SifraRadnika',
      'src.DIVUnosa',
      'src.DIVIspravke',
      'src.Prioritet',
    ],
    joinForOpen: 'INNER JOIN dbo.tRN rn ON rn.IDRN = src.IDRN',
    openWhere: 'ISNULL(rn.StatusRN, 0) = 0',
    map: mapLineRow,
  },
  tech: {
    target: 'bigtehn_tech_routing_cache',
    idCol: 'IDPostupka',
    from: 'dbo.tTehPostupak src',
    selectCols: [
      'src.IDPostupka',
      'src.SifraRadnika',
      'src.IDPredmet',
      'src.IdentBroj',
      'src.Varijanta',
      'src.PrnTimer',
      'src.DatumIVremeUnosa',
      'src.Operacija',
      'src.RJgrupaRC',
      'src.Toznaka',
      'src.Komada',
      'src.Potpis',
      'src.DatumIVremeZavrsetka',
      'src.ZavrsenPostupak',
      'CAST(src.Napomena AS NVARCHAR(MAX)) AS Napomena',
      'src.IDRN',
      'src.IDVrstaKvaliteta',
      'src.DoradaOperacije',
    ],
    joinForOpen: 'INNER JOIN dbo.tRN rn ON rn.IDRN = src.IDRN',
    openWhere: 'ISNULL(rn.StatusRN, 0) = 0',
    map: mapTechRow,
  },
};

function createSupabaseServiceClient() {
  return createClient(requiredEnv('SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-production-backfill': '1' } },
  });
}

async function createMssqlPool() {
  return await new sql.ConnectionPool({
    server: requiredEnv('MSSQL_HOST'),
    port: intEnv('MSSQL_PORT', 1433),
    user: requiredEnv('MSSQL_USER'),
    password: requiredEnv('MSSQL_PASSWORD'),
    database: requiredEnv('MSSQL_DATABASE'),
    options: {
      encrypt: boolEnv('MSSQL_ENCRYPT', true),
      trustServerCertificate: boolEnv('MSSQL_TRUST_SERVER_CERT', true),
    },
    pool: {
      max: intEnv('MSSQL_POOL_MAX', 5),
      min: 0,
      idleTimeoutMillis: intEnv('MSSQL_IDLE_TIMEOUT_MS', 30000),
    },
    requestTimeout: intEnv('MSSQL_REQUEST_TIMEOUT_MS', 120000),
  }).connect();
}

function fromClause(src, scope) {
  if (scope === 'open' && src.joinForOpen) {
    return `${src.from} ${src.joinForOpen}`;
  }
  return src.from;
}

function whereClause(src, scope) {
  const parts = [`src.${src.idCol} > @LastId`];
  if (scope === 'open' && src.openWhere) parts.push(src.openWhere);
  return parts.join(' AND ');
}

async function countMssqlRows(sql, pool, src, scope) {
  const req = pool.request();
  req.input('LastId', sql.Int, 0);
  const q = `
    SELECT COUNT(*) AS n
    FROM ${fromClause(src, scope)}
    WHERE ${whereClause(src, scope)}
  `;
  const res = await req.query(q);
  return Number(res.recordset?.[0]?.n ?? 0);
}

async function* selectMssqlBatches(sql, pool, src, { scope, batchSize, limit }) {
  let lastId = 0;
  let fetched = 0;

  while (true) {
    const req = pool.request();
    req.input('LastId', sql.Int, lastId);
    req.input('BatchSize', sql.Int, batchSize);
    const q = `
      SELECT TOP (@BatchSize) ${src.selectCols.join(',\n        ')}
      FROM ${fromClause(src, scope)}
      WHERE ${whereClause(src, scope)}
      ORDER BY src.${src.idCol} ASC
    `;
    const res = await req.query(q);
    const rows = res.recordset ?? [];
    if (rows.length === 0) return;

    lastId = Number(rows[rows.length - 1][src.idCol]);
    fetched += rows.length;
    yield rows;

    if (rows.length < batchSize) return;
    if (limit && fetched >= limit) return;
  }
}

async function upsertBatch(sb, table, rows) {
  if (!rows.length) return;
  const { error } = await sb.from(table).upsert(rows, { onConflict: 'id' });
  if (error) throw new Error(`${table} upsert failed: ${error.message}`);
}

async function syncOneTable(sql, pool, sb, tableKey, args) {
  const src = SOURCES[tableKey];
  logger.info('table sync starting', {
    table: tableKey,
    target: src.target,
    scope: args.scope,
    batch: args.batch,
    limit: args.limit,
    dry_run: args.dryRun,
  });

  const totalMssql = await countMssqlRows(sql, pool, src, args.scope);
  logger.info('mssql source size', { table: tableKey, total_rows: totalMssql });

  let seen = 0;
  let upserted = 0;

  for await (const rows of selectMssqlBatches(sql, pool, src, {
    scope: args.scope,
    batchSize: args.batch,
    limit: args.limit,
  })) {
    seen += rows.length;
    const mapped = rows.map(src.map);
    if (!args.dryRun) await upsertBatch(sb, src.target, mapped);
    upserted += mapped.length;

    logger.info('batch done', {
      table: tableKey,
      seen,
      upserted,
      last_id: rows[rows.length - 1][src.idCol],
    });

    if (args.limit && seen >= args.limit) break;
  }

  logger.info('table sync complete', { table: tableKey, seen, upserted, dry_run: args.dryRun });
  return { table: tableKey, seen, upserted };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  logger.info('production backfill starting', {
    scope: args.scope,
    tables: args.tables,
    batch: args.batch,
    limit: args.limit,
    dry_run: args.dryRun,
  });

  /* Standalone: ne zavisi od internog src/config/logger layout-a produkcionog bridge-a. */
  const sb = createSupabaseServiceClient();
  const pool = await createMssqlPool();

  try {
    const results = [];
    for (const tableKey of args.tables) {
      results.push(await syncOneTable(sql, pool, sb, tableKey, args));
    }
    logger.info('production backfill complete', { results, dry_run: args.dryRun });
  } finally {
    await pool.close();
  }
}

main().catch(err => {
  logger.error('fatal', { error: err?.message || String(err), stack: err?.stack });
  process.exit(1);
});
