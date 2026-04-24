# Supabase: šema baze (public)

Generisano: 2026-04-22. Izvor: živa Supabase baza, šema `public` (baze tabela, pogledi, enum tipovi, strani ključevi, flat pregled svih kolona).

## Šta ovaj dokument pokriva

- **Baze tabele (BASE TABLE)**: 58 tabela, kolone u jednoj flat tabeli (pogodno za pretragu).
- **Pregledi (views)**: 12 objekata u `public` (definicija SQL-a je u migracijama; ovde su samo imena).
- **Enum vrednosti**: svi korisnički enum tipovi u `public` sa labelama.
- **Strani ključevi (FOREIGN KEY)**: ograničenja koja referenciraju druge tabele (unutar `public`).

Ispod: **Pregledi**, **Enumi**, **Foreign keys**, zatim **flat tabela svih kolona** (fajl baze).

---

## Pregledi (views) u public

- `v_akcioni_plan`
- `v_employee_current_salary`
- `v_employees_safe`
- `v_maint_machine_current_status`
- `v_maint_machine_last_check`
- `v_maint_machines_importable`
- `v_maint_machines_with_responsible`
- `v_maint_task_due_dates`
- `v_pm_teme_pregled`
- `v_production_operations`
- `v_salary_payroll_month`
- `v_vacation_balance`

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

## Sve tabele: kolone (flat)

| tabela | kolona | data_type | nullable |
|--------|--------|-----------|----------|
| absences | id | uuid | NO |
| absences | employee_id | uuid | NO |
| absences | type | text | NO |
| absences | date_from | date(0) | NO |
| absences | date_to | date(0) | NO |
| absences | days_count | integer(32,0) | YES |
| absences | note | text | YES |
| absences | created_at | timestamp with time zone(6) | YES |
| absences | updated_at | timestamp with time zone(6) | YES |
| absences | paid_reason | text | YES |
| akcioni_plan | id | uuid | NO |
| akcioni_plan | sastanak_id | uuid | YES |
| akcioni_plan | tema_id | uuid | YES |
| akcioni_plan | projekat_id | uuid | YES |
| akcioni_plan | rb | integer(32,0) | YES |
| akcioni_plan | naslov | text | NO |
| akcioni_plan | opis | text | YES |
| akcioni_plan | odgovoran_email | text | YES |
| akcioni_plan | odgovoran_label | text | YES |
| akcioni_plan | odgovoran_text | text | YES |
| akcioni_plan | rok | date(0) | YES |
| akcioni_plan | rok_text | text | YES |
| akcioni_plan | status | text | NO |
| akcioni_plan | prioritet | integer(32,0) | NO |
| akcioni_plan | zatvoren_at | timestamp with time zone(6) | YES |
| akcioni_plan | zatvoren_by_email | text | YES |
| akcioni_plan | zatvoren_napomena | text | YES |
| akcioni_plan | created_at | timestamp with time zone(6) | NO |
| akcioni_plan | created_by_email | text | YES |
| akcioni_plan | updated_at | timestamp with time zone(6) | NO |
| audit_log | id | bigint(64,0) | NO |
| audit_log | table_name | text | NO |
| audit_log | record_id | text | YES |
| audit_log | action | text | NO |
| audit_log | actor_email | text | YES |
| audit_log | actor_uid | uuid | YES |
| audit_log | changed_at | timestamp with time zone(6) | NO |
| audit_log | old_data | jsonb | YES |
| audit_log | new_data | jsonb | YES |
| audit_log | diff_keys | text[] | YES |
| bigtehn_customers_cache | id | integer(32,0) | NO |
| bigtehn_customers_cache | name | text | NO |
| bigtehn_customers_cache | short_name | text | YES |
| bigtehn_customers_cache | city | text | YES |
| bigtehn_customers_cache | tax_id | text | YES |
| bigtehn_customers_cache | synced_at | timestamp with time zone(6) | NO |
| bigtehn_departments_cache | id | text | NO |
| bigtehn_departments_cache | name | text | NO |
| bigtehn_departments_cache | synced_at | timestamp with time zone(6) | NO |
| bigtehn_drawings_cache | id | bigint(64,0) | NO |
| bigtehn_drawings_cache | drawing_no | text | NO |
| bigtehn_drawings_cache | storage_path | text | NO |
| bigtehn_drawings_cache | original_path | text | YES |
| bigtehn_drawings_cache | file_name | text | NO |
| bigtehn_drawings_cache | mime_type | text | YES |
| bigtehn_drawings_cache | size_bytes | bigint(64,0) | YES |
| bigtehn_drawings_cache | mtime | timestamp with time zone(6) | NO |
| bigtehn_drawings_cache | synced_at | timestamp with time zone(6) | NO |
| bigtehn_drawings_cache | removed_at | timestamp with time zone(6) | YES |
| bigtehn_items_cache | id | integer(32,0) | NO |
| bigtehn_items_cache | broj_predmeta | text | NO |
| bigtehn_items_cache | naziv_predmeta | text | YES |
| bigtehn_items_cache | opis | text | YES |
| bigtehn_items_cache | status | text | YES |
| bigtehn_items_cache | customer_id | integer(32,0) | YES |
| bigtehn_items_cache | seller_id | integer(32,0) | YES |
| bigtehn_items_cache | work_type_id | integer(32,0) | YES |
| bigtehn_items_cache | department_code | text | YES |
| bigtehn_items_cache | broj_ugovora | text | YES |
| bigtehn_items_cache | broj_narudzbenice | text | YES |
| bigtehn_items_cache | datum_otvaranja | timestamp with time zone(6) | YES |
| bigtehn_items_cache | datum_zakljucenja | timestamp with time zone(6) | YES |
| bigtehn_items_cache | rok_zavrsetka | timestamp with time zone(6) | YES |
| bigtehn_items_cache | datum_ugovora | timestamp with time zone(6) | YES |
| bigtehn_items_cache | datum_narudzbenice | timestamp with time zone(6) | YES |
| bigtehn_items_cache | modified_at | timestamp with time zone(6) | YES |
| bigtehn_items_cache | synced_at | timestamp with time zone(6) | NO |
| bigtehn_locations_cache | id | integer(32,0) | NO |
| bigtehn_locations_cache | code | text | NO |
| bigtehn_locations_cache | name | text | YES |
| bigtehn_locations_cache | department_id | text | YES |
| bigtehn_locations_cache | is_active | boolean | YES |
| bigtehn_locations_cache | synced_at | timestamp with time zone(6) | NO |
| bigtehn_machines_cache | rj_code | text | NO |
| bigtehn_machines_cache | name | text | NO |
| bigtehn_machines_cache | department_id | text | YES |
| bigtehn_machines_cache | operation_id | integer(32,0) | YES |
| bigtehn_machines_cache | note | text | YES |
| bigtehn_machines_cache | no_procedure | boolean | YES |
| bigtehn_machines_cache | significant_for_completion | boolean | YES |
| bigtehn_machines_cache | uses_priority | boolean | YES |
| bigtehn_machines_cache | skippable | boolean | YES |
| bigtehn_machines_cache | synced_at | timestamp with time zone(6) | NO |
| bigtehn_part_movements_cache | id | bigint(64,0) | NO |
| bigtehn_part_movements_cache | work_order_id | bigint(64,0) | YES |
| bigtehn_part_movements_cache | item_id | bigint(64,0) | YES |
| bigtehn_part_movements_cache | quality_type_id | bigint(64,0) | YES |
| bigtehn_part_movements_cache | position_id | bigint(64,0) | YES |
| bigtehn_part_movements_cache | worker_id | bigint(64,0) | YES |
| bigtehn_part_movements_cache | datum | timestamp with time zone(6) | YES |
| bigtehn_part_movements_cache | kolicina | integer(32,0) | NO |
| bigtehn_part_movements_cache | created_at | timestamp with time zone(6) | YES |
| bigtehn_part_movements_cache | synced_at | timestamp with time zone(6) | NO |
| bigtehn_positions_cache | id | integer(32,0) | NO |
| bigtehn_positions_cache | code | text | NO |
| bigtehn_positions_cache | description | text | YES |
| bigtehn_positions_cache | synced_at | timestamp with time zone(6) | NO |
| bigtehn_quality_types_cache | id | integer(32,0) | NO |
| bigtehn_quality_types_cache | name | text | NO |
| bigtehn_quality_types_cache | synced_at | timestamp with time zone(6) | NO |
| bigtehn_tech_routing_cache | id | bigint(64,0) | NO |
| bigtehn_tech_routing_cache | work_order_id | bigint(64,0) | YES |
| bigtehn_tech_routing_cache | item_id | bigint(64,0) | YES |
| bigtehn_tech_routing_cache | worker_id | bigint(64,0) | YES |
| bigtehn_tech_routing_cache | quality_type_id | bigint(64,0) | YES |
| bigtehn_tech_routing_cache | operacija | integer(32,0) | NO |
| bigtehn_tech_routing_cache | machine_code | text | YES |
| bigtehn_tech_routing_cache | komada | integer(32,0) | NO |
| bigtehn_tech_routing_cache | prn_timer_seconds | integer(32,0) | YES |
| bigtehn_tech_routing_cache | started_at | timestamp with time zone(6) | YES |
| bigtehn_tech_routing_cache | finished_at | timestamp with time zone(6) | YES |
| bigtehn_tech_routing_cache | is_completed | boolean | NO |
| bigtehn_tech_routing_cache | ident_broj | text | YES |
| bigtehn_tech_routing_cache | varijanta | integer(32,0) | NO |
| bigtehn_tech_routing_cache | toznaka | text | YES |
| bigtehn_tech_routing_cache | potpis | text | YES |
| bigtehn_tech_routing_cache | napomena | text | YES |
| bigtehn_tech_routing_cache | dorada_operacije | integer(32,0) | NO |
| bigtehn_tech_routing_cache | synced_at | timestamp with time zone(6) | NO |
| bigtehn_work_order_approvals_cache | id | bigint(64,0) | NO |
| bigtehn_work_order_approvals_cache | work_order_id | bigint(64,0) | NO |
| bigtehn_work_order_approvals_cache | saglasan | boolean | NO |
| bigtehn_work_order_approvals_cache | datum_unosa | timestamp with time zone(6) | YES |
| bigtehn_work_order_approvals_cache | created_at | timestamp with time zone(6) | YES |
| bigtehn_work_order_approvals_cache | author_worker_id | bigint(64,0) | YES |
| bigtehn_work_order_approvals_cache | potpis_unos | text | YES |
| bigtehn_work_order_approvals_cache | modified_at | timestamp with time zone(6) | YES |
| bigtehn_work_order_approvals_cache | modifier_worker_id | bigint(64,0) | YES |
| bigtehn_work_order_approvals_cache | potpis_ispravka | text | YES |
| bigtehn_work_order_approvals_cache | synced_at | timestamp with time zone(6) | NO |
| bigtehn_work_order_launches_cache | id | bigint(64,0) | NO |
| bigtehn_work_order_launches_cache | work_order_id | bigint(64,0) | NO |
| bigtehn_work_order_launches_cache | lansiran | boolean | NO |
| bigtehn_work_order_launches_cache | datum_unosa | timestamp with time zone(6) | YES |
| bigtehn_work_order_launches_cache | created_at | timestamp with time zone(6) | YES |
| bigtehn_work_order_launches_cache | author_worker_id | bigint(64,0) | YES |
| bigtehn_work_order_launches_cache | potpis_unos | text | YES |
| bigtehn_work_order_launches_cache | modified_at | timestamp with time zone(6) | YES |
| bigtehn_work_order_launches_cache | modifier_worker_id | bigint(64,0) | YES |
| bigtehn_work_order_launches_cache | potpis_ispravka | text | YES |
| bigtehn_work_order_launches_cache | synced_at | timestamp with time zone(6) | NO |
| bigtehn_work_order_lines_cache | id | bigint(64,0) | NO |
| bigtehn_work_order_lines_cache | work_order_id | bigint(64,0) | NO |
| bigtehn_work_order_lines_cache | operacija | integer(32,0) | NO |
| bigtehn_work_order_lines_cache | machine_code | text | YES |
| bigtehn_work_order_lines_cache | opis_rada | text | YES |
| bigtehn_work_order_lines_cache | alat_pribor | text | YES |
| bigtehn_work_order_lines_cache | tpz | double precision(53) | NO |
| bigtehn_work_order_lines_cache | tk | double precision(53) | NO |
| bigtehn_work_order_lines_cache | tezina_to | double precision(53) | NO |
| bigtehn_work_order_lines_cache | author_worker_id | bigint(64,0) | YES |
| bigtehn_work_order_lines_cache | created_at | timestamp with time zone(6) | YES |
| bigtehn_work_order_lines_cache | modified_at | timestamp with time zone(6) | YES |
| bigtehn_work_order_lines_cache | prioritet | integer(32,0) | NO |
| bigtehn_work_order_lines_cache | synced_at | timestamp with time zone(6) | NO |
| bigtehn_work_orders_cache | id | bigint(64,0) | NO |
| bigtehn_work_orders_cache | item_id | bigint(64,0) | YES |
| bigtehn_work_orders_cache | customer_id | bigint(64,0) | YES |
| bigtehn_work_orders_cache | ident_broj | text | NO |
| bigtehn_work_orders_cache | varijanta | integer(32,0) | NO |
| bigtehn_work_orders_cache | broj_crteza | text | YES |
| bigtehn_work_orders_cache | naziv_dela | text | YES |
| bigtehn_work_orders_cache | materijal | text | YES |
| bigtehn_work_orders_cache | dimenzija_materijala | text | YES |
| bigtehn_work_orders_cache | jedinica_mere | text | YES |
| bigtehn_work_orders_cache | komada | integer(32,0) | NO |
| bigtehn_work_orders_cache | tezina_neobr | double precision(53) | NO |
| bigtehn_work_orders_cache | tezina_obr | double precision(53) | NO |
| bigtehn_work_orders_cache | status_rn | boolean | NO |
| bigtehn_work_orders_cache | zakljucano | boolean | NO |
| bigtehn_work_orders_cache | revizija | text | YES |
| bigtehn_work_orders_cache | quality_type_id | bigint(64,0) | YES |
| bigtehn_work_orders_cache | handover_status_id | integer(32,0) | YES |
| bigtehn_work_orders_cache | napomena | text | YES |
| bigtehn_work_orders_cache | rok_izrade | timestamp with time zone(6) | YES |
| bigtehn_work_orders_cache | datum_unosa | timestamp with time zone(6) | YES |
| bigtehn_work_orders_cache | created_at | timestamp with time zone(6) | YES |
| bigtehn_work_orders_cache | modified_at | timestamp with time zone(6) | YES |
| bigtehn_work_orders_cache | author_worker_id | bigint(64,0) | YES |
| bigtehn_work_orders_cache | synced_at | timestamp with time zone(6) | NO |
| bigtehn_worker_types_cache | id | integer(32,0) | NO |
| bigtehn_worker_types_cache | name | text | NO |
| bigtehn_worker_types_cache | has_extra_auth | boolean | YES |
| bigtehn_worker_types_cache | synced_at | timestamp with time zone(6) | NO |
| bigtehn_workers_cache | id | integer(32,0) | NO |
| bigtehn_workers_cache | full_name | text | NO |
| bigtehn_workers_cache | short_name | text | YES |
| bigtehn_workers_cache | department_id | text | YES |
| bigtehn_workers_cache | card_id | text | YES |
| bigtehn_workers_cache | worker_type_id | integer(32,0) | YES |
| bigtehn_workers_cache | is_active | boolean | YES |
| bigtehn_workers_cache | synced_at | timestamp with time zone(6) | NO |
| bridge_sync_log | id | bigint(64,0) | NO |
| bridge_sync_log | sync_job | text | NO |
| bridge_sync_log | started_at | timestamp with time zone(6) | NO |
| bridge_sync_log | finished_at | timestamp with time zone(6) | YES |
| bridge_sync_log | status | text | NO |
| bridge_sync_log | rows_inserted | integer(32,0) | YES |
| bridge_sync_log | rows_updated | integer(32,0) | YES |
| bridge_sync_log | rows_deleted | integer(32,0) | YES |
| bridge_sync_log | error_message | text | YES |
| bridge_sync_log | duration_ms | integer(32,0) | YES |
| contracts | id | uuid | NO |
| contracts | employee_id | uuid | NO |
| contracts | contract_type | text | NO |
| contracts | contract_number | text | YES |
| contracts | position | text | YES |
| contracts | date_from | date(0) | NO |
| contracts | date_to | date(0) | YES |
| contracts | is_active | boolean | YES |
| contracts | note | text | YES |
| contracts | created_at | timestamp with time zone(6) | YES |
| contracts | updated_at | timestamp with time zone(6) | YES |
| employee_children | id | uuid | NO |
| employee_children | employee_id | uuid | NO |
| employee_children | first_name | text | NO |
| employee_children | birth_date | date(0) | YES |
| employee_children | note | text | YES |
| employee_children | created_at | timestamp with time zone(6) | YES |
| employee_children | updated_at | timestamp with time zone(6) | YES |
| employees | id | uuid | NO |
| employees | full_name | text | NO |
| employees | position | text | YES |
| employees | department | text | YES |
| employees | phone | text | YES |
| employees | email | text | YES |
| employees | hire_date | date(0) | YES |
| employees | is_active | boolean | YES |
| employees | note | text | YES |
| employees | created_at | timestamp with time zone(6) | YES |
| employees | updated_at | timestamp with time zone(6) | YES |
| employees | first_name | text | YES |
| employees | last_name | text | YES |
| employees | personal_id | text | YES |
| employees | birth_date | date(0) | YES |
| employees | gender | text | YES |
| employees | address | text | YES |
| employees | city | text | YES |
| employees | postal_code | text | YES |
| employees | bank_name | text | YES |
| employees | bank_account | text | YES |
| employees | phone_private | text | YES |
| employees | emergency_contact_name | text | YES |
| employees | emergency_contact_phone | text | YES |
| employees | slava | text | YES |
| employees | slava_day | text | YES |
| employees | education_level | text | YES |
| employees | education_title | text | YES |
| employees | medical_exam_date | date(0) | YES |
| employees | medical_exam_expires | date(0) | YES |
| employees | team | text | YES |
| kadr_notification_config | id | integer(32,0) | NO |
| kadr_notification_config | enabled | boolean | NO |
| kadr_notification_config | medical_lead_days | integer(32,0) | NO |
| kadr_notification_config | contract_lead_days | integer(32,0) | NO |
| kadr_notification_config | birthday_enabled | boolean | NO |
| kadr_notification_config | work_anniversary_enabled | boolean | NO |
| kadr_notification_config | whatsapp_recipients | text[] | NO |
| kadr_notification_config | email_recipients | text[] | NO |
| kadr_notification_config | updated_at | timestamp with time zone(6) | YES |
| kadr_notification_config | updated_by | text | YES |
| kadr_notification_log | id | uuid | NO |
| kadr_notification_log | channel | text | NO |
| kadr_notification_log | recipient | text | NO |
| kadr_notification_log | subject | text | YES |
| kadr_notification_log | body | text | NO |
| kadr_notification_log | related_entity_type | text | NO |
| kadr_notification_log | related_entity_id | text | YES |
| kadr_notification_log | employee_id | uuid | YES |
| kadr_notification_log | notification_type | text | NO |
| kadr_notification_log | status | text | NO |
| kadr_notification_log | scheduled_at | timestamp with time zone(6) | NO |
| kadr_notification_log | next_attempt_at | timestamp with time zone(6) | NO |
| kadr_notification_log | attempts | integer(32,0) | NO |
| kadr_notification_log | last_attempt_at | timestamp with time zone(6) | YES |
| kadr_notification_log | sent_at | timestamp with time zone(6) | YES |
| kadr_notification_log | error | text | YES |
| kadr_notification_log | payload | jsonb | YES |
| kadr_notification_log | created_at | timestamp with time zone(6) | YES |
| kadr_notification_log | updated_at | timestamp with time zone(6) | YES |
| loc_item_placements | id | uuid | NO |
| loc_item_placements | item_ref_table | text | NO |
| loc_item_placements | item_ref_id | text | NO |
| loc_item_placements | location_id | uuid | NO |
| loc_item_placements | placement_status | loc_placement_status_enum | NO |
| loc_item_placements | last_movement_id | uuid | YES |
| loc_item_placements | placed_at | timestamp with time zone(6) | NO |
| loc_item_placements | placed_by | uuid | YES |
| loc_item_placements | notes | text | YES |
| loc_item_placements | updated_at | timestamp with time zone(6) | NO |
| loc_item_placements | quantity | numeric(12,3) | NO |
| loc_item_placements | order_no | text | NO |
| loc_item_placements | drawing_no | text | NO |
| loc_location_movements | id | uuid | NO |
| loc_location_movements | item_ref_table | text | NO |
| loc_location_movements | item_ref_id | text | NO |
| loc_location_movements | from_location_id | uuid | YES |
| loc_location_movements | to_location_id | uuid | NO |
| loc_location_movements | movement_type | loc_movement_type_enum | NO |
| loc_location_movements | movement_reason | text | YES |
| loc_location_movements | note | text | YES |
| loc_location_movements | moved_at | timestamp with time zone(6) | NO |
| loc_location_movements | moved_by | uuid | NO |
| loc_location_movements | approved_by | uuid | YES |
| loc_location_movements | approved_at | timestamp with time zone(6) | YES |
| loc_location_movements | correction_of_movement_id | uuid | YES |
| loc_location_movements | sync_status | loc_sync_status_enum | NO |
| loc_location_movements | created_at | timestamp with time zone(6) | NO |
| loc_location_movements | quantity | numeric(12,3) | NO |
| loc_location_movements | order_no | text | NO |
| loc_location_movements | drawing_no | text | NO |
| loc_locations | id | uuid | NO |
| loc_locations | location_code | text | NO |
| loc_locations | name | text | NO |
| loc_locations | location_type | loc_type_enum | NO |
| loc_locations | parent_id | uuid | YES |
| loc_locations | path_cached | text | NO |
| loc_locations | depth | smallint(16,0) | NO |
| loc_locations | is_active | boolean | NO |
| loc_locations | capacity_note | text | YES |
| loc_locations | notes | text | YES |
| loc_locations | created_at | timestamp with time zone(6) | NO |
| loc_locations | created_by | uuid | YES |
| loc_locations | updated_at | timestamp with time zone(6) | NO |
| loc_locations | updated_by | uuid | YES |
| loc_sync_outbound_events | id | uuid | NO |
| loc_sync_outbound_events | source_table | text | NO |
| loc_sync_outbound_events | source_record_id | uuid | NO |
| loc_sync_outbound_events | target_procedure | text | NO |
| loc_sync_outbound_events | payload | jsonb | NO |
| loc_sync_outbound_events | status | loc_sync_status_enum | NO |
| loc_sync_outbound_events | attempts | smallint(16,0) | NO |
| loc_sync_outbound_events | last_error | text | YES |
| loc_sync_outbound_events | locked_by_worker | text | YES |
| loc_sync_outbound_events | locked_at | timestamp with time zone(6) | YES |
| loc_sync_outbound_events | next_retry_at | timestamp with time zone(6) | YES |
| loc_sync_outbound_events | created_at | timestamp with time zone(6) | NO |
| loc_sync_outbound_events | synced_at | timestamp with time zone(6) | YES |
| maint_checks | id | uuid | NO |
| maint_checks | task_id | uuid | NO |
| maint_checks | machine_code | text | NO |
| maint_checks | performed_by | uuid | NO |
| maint_checks | performed_at | timestamp with time zone(6) | NO |
| maint_checks | result | maint_check_result | NO |
| maint_checks | notes | text | YES |
| maint_checks | attachment_urls | text[] | NO |
| maint_checks | created_at | timestamp with time zone(6) | NO |
| maint_checks | updated_at | timestamp with time zone(6) | NO |
| maint_checks | updated_by | uuid | YES |
| maint_incident_events | id | uuid | NO |
| maint_incident_events | incident_id | uuid | NO |
| maint_incident_events | actor | uuid | YES |
| maint_incident_events | at | timestamp with time zone(6) | NO |
| maint_incident_events | event_type | text | NO |
| maint_incident_events | from_value | text | YES |
| maint_incident_events | to_value | text | YES |
| maint_incident_events | comment | text | YES |
| maint_incidents | id | uuid | NO |
| maint_incidents | machine_code | text | NO |
| maint_incidents | reported_by | uuid | NO |
| maint_incidents | reported_at | timestamp with time zone(6) | NO |
| maint_incidents | title | text | NO |
| maint_incidents | description | text | YES |
| maint_incidents | severity | maint_incident_severity | NO |
| maint_incidents | status | maint_incident_status | NO |
| maint_incidents | assigned_to | uuid | YES |
| maint_incidents | resolved_at | timestamp with time zone(6) | YES |
| maint_incidents | closed_at | timestamp with time zone(6) | YES |
| maint_incidents | resolution_notes | text | YES |
| maint_incidents | downtime_minutes | integer(32,0) | YES |
| maint_incidents | attachment_urls | text[] | NO |
| maint_incidents | created_at | timestamp with time zone(6) | NO |
| maint_incidents | updated_at | timestamp with time zone(6) | NO |
| maint_incidents | updated_by | uuid | YES |
| maint_machine_files | id | uuid | NO |
| maint_machine_files | machine_code | text | NO |
| maint_machine_files | file_name | text | NO |
| maint_machine_files | storage_path | text | NO |
| maint_machine_files | mime_type | text | YES |
| maint_machine_files | size_bytes | bigint(64,0) | YES |
| maint_machine_files | category | text | YES |
| maint_machine_files | description | text | YES |
| maint_machine_files | deleted_at | timestamp with time zone(6) | YES |
| maint_machine_files | uploaded_at | timestamp with time zone(6) | NO |
| maint_machine_files | uploaded_by | uuid | YES |
| maint_machine_notes | id | uuid | NO |
| maint_machine_notes | machine_code | text | NO |
| maint_machine_notes | author | uuid | NO |
| maint_machine_notes | content | text | NO |
| maint_machine_notes | pinned | boolean | NO |
| maint_machine_notes | created_at | timestamp with time zone(6) | NO |
| maint_machine_notes | updated_at | timestamp with time zone(6) | NO |
| maint_machine_notes | deleted_at | timestamp with time zone(6) | YES |
| maint_machine_status_override | machine_code | text | NO |
| maint_machine_status_override | status | maint_operational_status | NO |
| maint_machine_status_override | reason | text | NO |
| maint_machine_status_override | set_by | uuid | NO |
| maint_machine_status_override | set_at | timestamp with time zone(6) | NO |
| maint_machine_status_override | valid_until | timestamp with time zone(6) | YES |
| maint_machines | machine_code | text | NO |
| maint_machines | name | text | NO |
| maint_machines | type | text | YES |
| maint_machines | manufacturer | text | YES |
| maint_machines | model | text | YES |
| maint_machines | serial_number | text | YES |
| maint_machines | year_of_manufacture | integer(32,0) | YES |
| maint_machines | year_commissioned | integer(32,0) | YES |
| maint_machines | location | text | YES |
| maint_machines | department_id | text | YES |
| maint_machines | power_kw | numeric(6,2) | YES |
| maint_machines | weight_kg | numeric(10,2) | YES |
| maint_machines | notes | text | YES |
| maint_machines | tracked | boolean | NO |
| maint_machines | archived_at | timestamp with time zone(6) | YES |
| maint_machines | source | text | NO |
| maint_machines | created_at | timestamp with time zone(6) | NO |
| maint_machines | updated_at | timestamp with time zone(6) | NO |
| maint_machines | updated_by | uuid | YES |
| maint_machines | responsible_user_id | uuid | YES |
| maint_machines_deletion_log | id | uuid | NO |
| maint_machines_deletion_log | machine_code | text | NO |
| maint_machines_deletion_log | machine_name | text | YES |
| maint_machines_deletion_log | snapshot | jsonb | NO |
| maint_machines_deletion_log | related_counts | jsonb | NO |
| maint_machines_deletion_log | reason | text | NO |
| maint_machines_deletion_log | deleted_at | timestamp with time zone(6) | NO |
| maint_machines_deletion_log | deleted_by | uuid | YES |
| maint_machines_deletion_log | deleted_by_email | text | YES |
| maint_notification_log | id | uuid | NO |
| maint_notification_log | channel | maint_notification_channel | NO |
| maint_notification_log | recipient | text | NO |
| maint_notification_log | recipient_user_id | uuid | YES |
| maint_notification_log | subject | text | YES |
| maint_notification_log | body | text | NO |
| maint_notification_log | related_entity_type | text | YES |
| maint_notification_log | related_entity_id | uuid | YES |
| maint_notification_log | machine_code | text | YES |
| maint_notification_log | escalation_level | integer(32,0) | NO |
| maint_notification_log | status | maint_notification_status | NO |
| maint_notification_log | error | text | YES |
| maint_notification_log | sent_at | timestamp with time zone(6) | YES |
| maint_notification_log | created_at | timestamp with time zone(6) | NO |
| maint_notification_log | scheduled_at | timestamp with time zone(6) | NO |
| maint_notification_log | next_attempt_at | timestamp with time zone(6) | NO |
| maint_notification_log | last_attempt_at | timestamp with time zone(6) | YES |
| maint_notification_log | attempts | integer(32,0) | NO |
| maint_notification_log | payload | jsonb | YES |
| maint_tasks | id | uuid | NO |
| maint_tasks | machine_code | text | NO |
| maint_tasks | title | text | NO |
| maint_tasks | description | text | YES |
| maint_tasks | instructions | text | YES |
| maint_tasks | interval_value | integer(32,0) | NO |
| maint_tasks | interval_unit | maint_interval_unit | NO |
| maint_tasks | severity | maint_task_severity | NO |
| maint_tasks | required_role | maint_maint_role | NO |
| maint_tasks | grace_period_days | integer(32,0) | NO |
| maint_tasks | active | boolean | NO |
| maint_tasks | created_at | timestamp with time zone(6) | NO |
| maint_tasks | created_by | uuid | YES |
| maint_tasks | updated_at | timestamp with time zone(6) | NO |
| maint_tasks | updated_by | uuid | YES |
| maint_user_profiles | user_id | uuid | NO |
| maint_user_profiles | full_name | text | NO |
| maint_user_profiles | role | maint_maint_role | NO |
| maint_user_profiles | telegram_chat_id | text | YES |
| maint_user_profiles | assigned_machine_codes | text[] | NO |
| maint_user_profiles | active | boolean | NO |
| maint_user_profiles | created_at | timestamp with time zone(6) | NO |
| maint_user_profiles | updated_at | timestamp with time zone(6) | NO |
| maint_user_profiles | phone | text | YES |
| phases | id | uuid | NO |
| phases | project_id | uuid | NO |
| phases | work_package_id | uuid | NO |
| phases | phase_name | text | NO |
| phases | location | text | YES |
| phases | start_date | date(0) | YES |
| phases | end_date | date(0) | YES |
| phases | responsible_engineer | text | YES |
| phases | montage_lead | text | YES |
| phases | status | integer(32,0) | YES |
| phases | pct | integer(32,0) | YES |
| phases | checks | jsonb | YES |
| phases | blocker | text | YES |
| phases | note | text | YES |
| phases | sort_order | integer(32,0) | YES |
| phases | created_at | timestamp with time zone(6) | YES |
| phases | updated_at | timestamp with time zone(6) | YES |
| phases | updated_by | text | YES |
| phases | phase_type | text | YES |
| phases | description | text | YES |
| phases | linked_drawings | jsonb | NO |
| pm_teme | id | uuid | NO |
| pm_teme | vrsta | text | NO |
| pm_teme | oblast | text | NO |
| pm_teme | naslov | text | NO |
| pm_teme | opis | text | YES |
| pm_teme | projekat_id | uuid | YES |
| pm_teme | status | text | NO |
| pm_teme | prioritet | integer(32,0) | NO |
| pm_teme | sastanak_id | uuid | YES |
| pm_teme | predlozio_email | text | NO |
| pm_teme | predlozio_label | text | YES |
| pm_teme | predlozio_at | timestamp with time zone(6) | NO |
| pm_teme | resio_email | text | YES |
| pm_teme | resio_label | text | YES |
| pm_teme | resio_at | timestamp with time zone(6) | YES |
| pm_teme | resio_napomena | text | YES |
| pm_teme | created_at | timestamp with time zone(6) | NO |
| pm_teme | updated_at | timestamp with time zone(6) | NO |
| pm_teme | hitno | boolean | NO |
| pm_teme | za_razmatranje | boolean | NO |
| pm_teme | admin_rang | integer(32,0) | YES |
| pm_teme | admin_rang_by_email | text | YES |
| pm_teme | admin_rang_at | timestamp with time zone(6) | YES |
| presek_aktivnosti | id | uuid | NO |
| presek_aktivnosti | sastanak_id | uuid | NO |
| presek_aktivnosti | rb | integer(32,0) | NO |
| presek_aktivnosti | redosled | integer(32,0) | NO |
| presek_aktivnosti | naslov | text | NO |
| presek_aktivnosti | pod_rn | text | YES |
| presek_aktivnosti | sadrzaj_html | text | YES |
| presek_aktivnosti | sadrzaj_text | text | YES |
| presek_aktivnosti | odgovoran_email | text | YES |
| presek_aktivnosti | odgovoran_label | text | YES |
| presek_aktivnosti | odgovoran_text | text | YES |
| presek_aktivnosti | rok | date(0) | YES |
| presek_aktivnosti | rok_text | text | YES |
| presek_aktivnosti | status | text | NO |
| presek_aktivnosti | napomena | text | YES |
| presek_aktivnosti | created_at | timestamp with time zone(6) | NO |
| presek_aktivnosti | updated_at | timestamp with time zone(6) | NO |
| presek_slike | id | uuid | NO |
| presek_slike | sastanak_id | uuid | NO |
| presek_slike | aktivnost_id | uuid | YES |
| presek_slike | storage_path | text | NO |
| presek_slike | file_name | text | YES |
| presek_slike | mime_type | text | YES |
| presek_slike | size_bytes | bigint(64,0) | YES |
| presek_slike | caption | text | YES |
| presek_slike | redosled | integer(32,0) | NO |
| presek_slike | uploaded_by_email | text | YES |
| presek_slike | uploaded_at | timestamp with time zone(6) | NO |
| production_drawings | id | bigint(64,0) | NO |
| production_drawings | work_order_id | bigint(64,0) | NO |
| production_drawings | line_id | bigint(64,0) | NO |
| production_drawings | storage_path | text | NO |
| production_drawings | file_name | text | NO |
| production_drawings | mime_type | text | YES |
| production_drawings | size_bytes | bigint(64,0) | YES |
| production_drawings | uploaded_at | timestamp with time zone(6) | NO |
| production_drawings | uploaded_by | text | YES |
| production_drawings | deleted_at | timestamp with time zone(6) | YES |
| production_drawings | deleted_by | text | YES |
| production_overlays | id | bigint(64,0) | NO |
| production_overlays | work_order_id | bigint(64,0) | NO |
| production_overlays | line_id | bigint(64,0) | NO |
| production_overlays | shift_sort_order | integer(32,0) | YES |
| production_overlays | local_status | text | NO |
| production_overlays | shift_note | text | YES |
| production_overlays | assigned_machine_code | text | YES |
| production_overlays | created_at | timestamp with time zone(6) | NO |
| production_overlays | updated_at | timestamp with time zone(6) | NO |
| production_overlays | created_by | text | YES |
| production_overlays | updated_by | text | YES |
| production_overlays | archived_at | timestamp with time zone(6) | YES |
| production_overlays | archived_reason | text | YES |
| projects | id | uuid | NO |
| projects | project_code | text | NO |
| projects | project_name | text | NO |
| projects | projectm | text | YES |
| projects | project_deadline | date(0) | YES |
| projects | pm_email | text | YES |
| projects | leadpm_email | text | YES |
| projects | reminder_enabled | boolean | YES |
| projects | status | text | YES |
| projects | created_at | timestamp with time zone(6) | YES |
| projects | updated_at | timestamp with time zone(6) | YES |
| projekt_bigtehn_rn | projekat_id | uuid | NO |
| projekt_bigtehn_rn | bigtehn_rn_id | bigint(64,0) | NO |
| projekt_bigtehn_rn | napomena | text | YES |
| projekt_bigtehn_rn | created_at | timestamp with time zone(6) | NO |
| reminder_log | id | uuid | NO |
| reminder_log | project_id | uuid | YES |
| reminder_log | work_package_id | uuid | YES |
| reminder_log | phase_id | uuid | YES |
| reminder_log | sent_to | text | NO |
| reminder_log | sent_type | text | YES |
| reminder_log | sent_at | timestamp with time zone(6) | YES |
| reminder_log | status | text | YES |
| reminder_log | error_message | text | YES |
| salary_payroll | id | uuid | NO |
| salary_payroll | employee_id | uuid | NO |
| salary_payroll | period_year | integer(32,0) | NO |
| salary_payroll | period_month | integer(32,0) | NO |
| salary_payroll | salary_type | text | NO |
| salary_payroll | advance_amount | numeric(14,2) | NO |
| salary_payroll | advance_paid_on | date(0) | YES |
| salary_payroll | advance_note | text | YES |
| salary_payroll | fixed_salary | numeric(14,2) | NO |
| salary_payroll | hours_worked | numeric(8,2) | NO |
| salary_payroll | hourly_rate | numeric(12,2) | NO |
| salary_payroll | transport_rsd | numeric(12,2) | NO |
| salary_payroll | domestic_days | integer(32,0) | NO |
| salary_payroll | per_diem_rsd | numeric(12,2) | NO |
| salary_payroll | foreign_days | integer(32,0) | NO |
| salary_payroll | per_diem_eur | numeric(10,2) | NO |
| salary_payroll | total_rsd | numeric(14,2) | NO |
| salary_payroll | total_eur | numeric(14,2) | NO |
| salary_payroll | second_part_rsd | numeric(14,2) | NO |
| salary_payroll | final_paid_on | date(0) | YES |
| salary_payroll | status | text | NO |
| salary_payroll | note | text | YES |
| salary_payroll | created_by | text | YES |
| salary_payroll | created_at | timestamp with time zone(6) | YES |
| salary_payroll | updated_at | timestamp with time zone(6) | YES |
| salary_terms | id | uuid | NO |
| salary_terms | employee_id | uuid | NO |
| salary_terms | salary_type | text | NO |
| salary_terms | effective_from | date(0) | NO |
| salary_terms | effective_to | date(0) | YES |
| salary_terms | amount | numeric(14,2) | NO |
| salary_terms | amount_type | text | NO |
| salary_terms | currency | text | NO |
| salary_terms | hourly_rate | numeric(12,2) | YES |
| salary_terms | contract_ref | text | YES |
| salary_terms | note | text | YES |
| salary_terms | created_by | text | YES |
| salary_terms | created_at | timestamp with time zone(6) | YES |
| salary_terms | updated_at | timestamp with time zone(6) | YES |
| salary_terms | transport_allowance_rsd | numeric(12,2) | NO |
| salary_terms | per_diem_rsd | numeric(12,2) | NO |
| salary_terms | per_diem_eur | numeric(10,2) | NO |
| sastanak_arhiva | id | uuid | NO |
| sastanak_arhiva | sastanak_id | uuid | NO |
| sastanak_arhiva | snapshot | jsonb | NO |
| sastanak_arhiva | zapisnik_storage_path | text | YES |
| sastanak_arhiva | zapisnik_size_bytes | bigint(64,0) | YES |
| sastanak_arhiva | zapisnik_generated_at | timestamp with time zone(6) | YES |
| sastanak_arhiva | arhivirao_email | text | YES |
| sastanak_arhiva | arhivirao_label | text | YES |
| sastanak_arhiva | arhivirano_at | timestamp with time zone(6) | NO |
| sastanak_ucesnici | sastanak_id | uuid | NO |
| sastanak_ucesnici | email | text | NO |
| sastanak_ucesnici | label | text | YES |
| sastanak_ucesnici | prisutan | boolean | NO |
| sastanak_ucesnici | pozvan | boolean | NO |
| sastanak_ucesnici | napomena | text | YES |
| sastanci | id | uuid | NO |
| sastanci | tip | text | NO |
| sastanci | naslov | text | NO |
| sastanci | datum | date(0) | NO |
| sastanci | vreme | time without time zone(6) | YES |
| sastanci | mesto | text | YES |
| sastanci | projekat_id | uuid | YES |
| sastanci | vodio_email | text | YES |
| sastanci | vodio_label | text | YES |
| sastanci | zapisnicar_email | text | YES |
| sastanci | zapisnicar_label | text | YES |
| sastanci | status | text | NO |
| sastanci | zakljucan_at | timestamp with time zone(6) | YES |
| sastanci | zakljucan_by_email | text | YES |
| sastanci | napomena | text | YES |
| sastanci | created_at | timestamp with time zone(6) | NO |
| sastanci | created_by_email | text | YES |
| sastanci | updated_at | timestamp with time zone(6) | NO |
| user_roles | id | uuid | NO |
| user_roles | email | text | NO |
| user_roles | role | text | NO |
| user_roles | project_id | uuid | YES |
| user_roles | is_active | boolean | YES |
| user_roles | created_at | timestamp with time zone(6) | YES |
| user_roles | full_name | text | YES |
| user_roles | team | text | YES |
| user_roles | updated_at | timestamp with time zone(6) | YES |
| user_roles | created_by | text | YES |
| user_roles | must_change_password | boolean | YES |
| vacation_entitlements | id | uuid | NO |
| vacation_entitlements | employee_id | uuid | NO |
| vacation_entitlements | year | integer(32,0) | NO |
| vacation_entitlements | days_total | integer(32,0) | NO |
| vacation_entitlements | days_carried_over | integer(32,0) | NO |
| vacation_entitlements | note | text | YES |
| vacation_entitlements | created_at | timestamp with time zone(6) | YES |
| vacation_entitlements | updated_at | timestamp with time zone(6) | YES |
| work_hours | id | uuid | NO |
| work_hours | employee_id | uuid | NO |
| work_hours | work_date | date(0) | NO |
| work_hours | hours | numeric(5,2) | NO |
| work_hours | overtime_hours | numeric(5,2) | NO |
| work_hours | project_ref | text | YES |
| work_hours | note | text | YES |
| work_hours | created_at | timestamp with time zone(6) | YES |
| work_hours | updated_at | timestamp with time zone(6) | YES |
| work_hours | field_hours | numeric(5,2) | NO |
| work_hours | absence_code | text | YES |
| work_hours | two_machine_hours | numeric(5,2) | NO |
| work_hours | field_subtype | text | YES |
| work_packages | id | uuid | NO |
| work_packages | project_id | uuid | NO |
| work_packages | rn_code | text | YES |
| work_packages | rn_order | integer(32,0) | YES |
| work_packages | name | text | NO |
| work_packages | location | text | YES |
| work_packages | responsible_engineer_default | text | YES |
| work_packages | montage_lead_default | text | YES |
| work_packages | deadline | date(0) | YES |
| work_packages | sort_order | integer(32,0) | YES |
| work_packages | is_active | boolean | YES |
| work_packages | created_at | timestamp with time zone(6) | YES |
| work_packages | updated_at | timestamp with time zone(6) | YES |
