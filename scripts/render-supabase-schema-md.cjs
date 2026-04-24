/* eslint-disable no-console */
/**
 * Reads a Cursor agent-tools file containing a Supabase SQL result with key "b64"
 * and writes docs/SUPABASE_PUBLIC_SCHEMA.md (header is embedded below).
 * Usage: node scripts/render-supabase-schema-md.cjs <path-to-agent-tools-txt>
 */
const { readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { dirname, join } = require("node:path");

const inPath = process.argv[2];
if (!inPath) {
  console.error("Usage: node scripts/render-supabase-schema-md.cjs <path-to-agent-tools-txt>");
  process.exit(1);
}
const raw = readFileSync(inPath, "utf8");
// Agent-tools / MCP: inner JSON is escaped, so the pattern is b64\":\" not b64":"
// Anchor on known base64 prefix of our doc (## Sve + tabele) after UTF-8 encode.
const B64_START = "IyM";
const start = raw.indexOf(B64_START);
if (start < 0) {
  console.error("Could not find base64 payload start (", B64_START, ") in", inPath);
  process.exit(1);
}
// Payload ends with ...== before escaped quote + closing array: \"}]
let endPos = raw.indexOf('\\"}]', start);
if (endPos < 0) {
  endPos = raw.indexOf('"}]', start);
  if (endPos < 0) {
    console.error("Could not find end of b64 (\\\"}] or }]) in", inPath);
    process.exit(1);
  }
}
// JSON string for b64 can contain \ + newline as line continuations; strip those only
const b64 = raw
  .slice(start, endPos)
  .replace(/\\\r?\n/g, "")
  .replace(/\\n/g, "");
const columnFlat = Buffer.from(b64, "base64").toString("utf8");

const root = join(__dirname, "..");
const out = join(root, "docs", "SUPABASE_PUBLIC_SCHEMA.md");
const today = "2026-04-22";

const header = `# Supabase: šema baze (public)

Generisano: ${today}. Izvor: živa Supabase baza, šema \`public\` (baze tabela, pogledi, enum tipovi, strani ključevi, flat pregled svih kolona).

## Šta ovaj dokument pokriva

- **Baze tabele (BASE TABLE)**: 58 tabela, kolone u jednoj flat tabeli (pogodno za pretragu).
- **Pregledi (views)**: 12 objekata u \`public\` (definicija SQL-a je u migracijama; ovde su samo imena).
- **Enum vrednosti**: svi korisnički enum tipovi u \`public\` sa labelama.
- **Strani ključevi (FOREIGN KEY)**: ograničenja koja referenciraju druge tabele (unutar \`public\`).

Ispod: **Pregledi**, **Enumi**, **Foreign keys**, zatim **flat tabela svih kolona** (fajl baze).

---

## Pregledi (views) u public

- \`v_akcioni_plan\`
- \`v_employee_current_salary\`
- \`v_employees_safe\`
- \`v_maint_machine_current_status\`
- \`v_maint_machine_last_check\`
- \`v_maint_machines_importable\`
- \`v_maint_machines_with_responsible\`
- \`v_maint_task_due_dates\`
- \`v_pm_teme_pregled\`
- \`v_production_operations\`
- \`v_salary_payroll_month\`
- \`v_vacation_balance\`

---

## Enum tipovi (public)

### loc_movement_type_enum
| sort | value |
|------|-------|
| 1 | INITIAL_PLACEMENT |
| 2 | TRANSFER |
| 3 | ASSIGN_TO_PROJECT |
| 4 | RETURN_FROM_PROJECT |
| 5 | SEND_TO_SERVICE |
| 6 | RETURN_FROM_SERVICE |
| 7 | SEND_TO_FIELD |
| 8 | RETURN_FROM_FIELD |
| 9 | SCRAP |
| 10 | CORRECTION |
| 11 | INVENTORY_ADJUSTMENT |

### loc_placement_status_enum
| sort | value |
|------|-------|
| 1 | ACTIVE |
| 2 | IN_TRANSIT |
| 3 | PENDING_CONFIRMATION |
| 4 | UNKNOWN |

### loc_sync_status_enum
| sort | value |
|------|-------|
| 1 | PENDING |
| 2 | IN_PROGRESS |
| 3 | SYNCED |
| 4 | FAILED |
| 5 | DEAD_LETTER |

### loc_type_enum
| sort | value |
|------|-------|
| 1 | WAREHOUSE |
| 2 | RACK |
| 3 | SHELF |
| 4 | BIN |
| 5 | PROJECT |
| 6 | PRODUCTION |
| 7 | ASSEMBLY |
| 8 | SERVICE |
| 9 | FIELD |
| 10 | TRANSIT |
| 11 | OFFICE |
| 12 | TEMP |
| 13 | SCRAPPED |
| 14 | OTHER |

### maint_check_result
| sort | value |
|------|-------|
| 1 | ok |
| 2 | warning |
| 3 | fail |
| 4 | skipped |

### maint_incident_severity
| sort | value |
|------|-------|
| 1 | minor |
| 2 | major |
| 3 | critical |

### maint_incident_status
| sort | value |
|------|-------|
| 1 | open |
| 2 | acknowledged |
| 3 | in_progress |
| 4 | awaiting_parts |
| 5 | resolved |
| 6 | closed |

### maint_interval_unit
| sort | value |
|------|-------|
| 1 | hours |
| 2 | days |
| 3 | weeks |
| 4 | months |

### maint_maint_role
| sort | value |
|------|-------|
| 1 | operator |
| 2 | technician |
| 3 | chief |
| 4 | management |
| 5 | admin |

### maint_notification_channel
| sort | value |
|------|-------|
| 1 | telegram |
| 2 | email |
| 3 | in_app |
| 4 | whatsapp |

### maint_notification_status
| sort | value |
|------|-------|
| 1 | queued |
| 2 | sent |
| 3 | failed |

### maint_operational_status
| sort | value |
|------|-------|
| 1 | running |
| 2 | degraded |
| 3 | down |
| 4 | maintenance |

### maint_task_severity
| sort | value |
|------|-------|
| 1 | normal |
| 2 | important |
| 3 | critical |

---

## Strani ključevi (public → referenca)

| tabela (from) | kolona | tabela (to) |
|----------------|--------|-------------|
| absences | employee_id | employees |
| akcioni_plan | projekat_id | projects |
| akcioni_plan | tema_id | pm_teme |
| akcioni_plan | sastanak_id | sastanci |
| bigtehn_locations_cache | department_id | bigtehn_departments_cache |
| bigtehn_machines_cache | department_id | bigtehn_departments_cache |
| bigtehn_workers_cache | department_id | bigtehn_departments_cache |
| contracts | employee_id | employees |
| employee_children | employee_id | employees |
| kadr_notification_log | employee_id | employees |
| loc_item_placements | location_id | loc_locations |
| loc_item_placements | last_movement_id | loc_location_movements |
| loc_location_movements | from_location_id | loc_locations |
| loc_location_movements | to_location_id | loc_locations |
| loc_location_movements | correction_of_movement_id | loc_location_movements |
| loc_locations | parent_id | loc_locations |
| maint_checks | task_id | maint_tasks |
| maint_incident_events | incident_id | maint_incidents |
| phases | project_id | projects |
| phases | work_package_id | work_packages |
| pm_teme | projekat_id | projects |
| pm_teme | sastanak_id | sastanci |
| presek_aktivnosti | sastanak_id | sastanci |
| presek_slike | aktivnost_id | presek_aktivnosti |
| presek_slike | sastanak_id | sastanci |
| projekt_bigtehn_rn | projekat_id | projects |
| reminder_log | phase_id | phases |
| reminder_log | work_package_id | work_packages |
| reminder_log | project_id | projects |
| salary_payroll | employee_id | employees |
| salary_terms | employee_id | employees |
| sastanak_arhiva | sastanak_id | sastanci |
| sastanak_ucesnici | sastanak_id | sastanci |
| sastanci | projekat_id | projects |
| user_roles | project_id | projects |
| vacation_entitlements | employee_id | employees |
| work_hours | employee_id | employees |
| work_packages | project_id | projects |

---

`;

mkdirSync(dirname(out), { recursive: true });
const full = header + columnFlat + "\n";
writeFileSync(out, full, "utf8");
console.log("Wrote", out);
