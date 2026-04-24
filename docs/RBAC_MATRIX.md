# RBAC Matrix — auto-generisano

> **Generisano:** `node scripts/generate-rbac-matrix.cjs`
> **NE EDITUJ RUČNO** — promene će biti pregažene. Edituj migracije pa regeneriši.
> CI proverava sinhronizaciju: `node scripts/generate-rbac-matrix.cjs --check`.

## 1. Sažetak

- **Tabela sa RLS politikama:** 31
- **Ukupno efektivnih politika:** 90
- **SECURITY DEFINER funkcija:** 51
- **Objekata sa anon grant-om:** 2

## 2. Anon (javni) pristup

Svaki red u ovoj tabeli je *javno čitljiv* preko anon API ključa (koji ide u JS bundle).
Bilo šta osetljivo ovde znači security incident.

| Objekat | Privilegije |
|---|---|
| `current_user_is_admin` | `EXECUTE` |
| `current_user_is_hr_or_admin` | `EXECUTE` |

## 3. SECURITY DEFINER funkcije

Funkcije koje izvršavaju sa privilegijama vlasnika (bypass RLS-a). Svaka je potencijalna
eskalacija ako search_path nije postavljen ili ako logika ne proverava ulogu.

| Funkcija | Definisana u |
|---|---|
| `_loc_purge_synced_events_cron` | `sql/migrations/add_loc_step4_pgcron.sql` |
| `audit_log_cleanup` | `sql/migrations/add_audit_log.sql` |
| `audit_row_change` | `sql/migrations/add_audit_log.sql` |
| `can_edit_plan_proizvodnje` | `sql/migrations/add_plan_proizvodnje_menadzment_edit.sql` |
| `current_user_email` | `sql/migrations/add_audit_log.sql` |
| `current_user_is_admin` | `sql/migrations/fix_user_roles_rls_recursion.sql` |
| `current_user_is_hr_or_admin` | `sql/migrations/add_menadzment_full_edit_kadrovska.sql` |
| `current_user_is_management` | `sql/migrations/harden_sastanci_rls_phase2.sql` |
| `current_user_managed_departments` | `sql/migrations/add_rbac_managed_departments.sql` |
| `get_my_user_roles` | `sql/migrations/enable_user_roles_rls_proper.sql` |
| `has_edit_role` | `sql/migrations/add_menadzment_full_edit_kadrovska.sql` |
| `is_sastanak_ucesnik` | `sql/migrations/harden_sastanci_rls_phase2.sql` |
| `kadr_dispatch_dequeue` | `sql/migrations/add_kadr_notifications.sql` |
| `kadr_dispatch_mark_failed` | `sql/migrations/add_kadr_notifications.sql` |
| `kadr_dispatch_mark_sent` | `sql/migrations/add_kadr_notifications.sql` |
| `kadr_payroll_init_month` | `sql/migrations/add_kadr_payroll_v2.sql` |
| `kadr_schedule_hr_reminders` | `sql/migrations/add_kadr_notifications.sql` |
| `kadr_trigger_schedule_hr_reminders` | `sql/migrations/add_kadr_notifications.sql` |
| `loc_after_movement_insert` | `sql/migrations/add_loc_v4_drawing_no.sql` |
| `loc_auth_roles` | `sql/migrations/add_loc_module.sql` |
| `loc_can_manage_locations` | `sql/migrations/add_loc_module.sql` |
| `loc_claim_sync_events` | `sql/migrations/add_loc_step5_sync_rpcs.sql` |
| `loc_create_movement` | `sql/migrations/add_loc_v4_drawing_no.sql` |
| `loc_is_admin` | `sql/migrations/add_loc_module.sql` |
| `loc_locations_after_path_change` | `sql/migrations/add_loc_module.sql` |
| `loc_mark_sync_failed` | `sql/migrations/add_loc_step5_sync_rpcs.sql` |
| `loc_mark_sync_synced` | `sql/migrations/add_loc_step5_sync_rpcs.sql` |
| `loc_purge_synced_events` | `sql/migrations/add_loc_step3_cleanup.sql` |
| `loc_touch_updated_at` | `sql/migrations/add_loc_module.sql` |
| `maint_assignable_users` | `sql/migrations/add_maint_assignable_users_rpc.sql` |
| `maint_assigned_machine_codes` | `sql/migrations/add_maintenance_module.sql` |
| `maint_can_close_incident` | `sql/migrations/add_maint_rls_menadzment_paritet.sql` |
| `maint_dispatch_dequeue` | `sql/migrations/add_maint_notify_dispatch_rpc.sql` |
| `maint_dispatch_fanout` | `sql/migrations/add_maint_notify_dispatch_rpc.sql` |
| `maint_dispatch_mark_failed` | `sql/migrations/add_maint_notify_dispatch_rpc.sql` |
| `maint_dispatch_mark_sent` | `sql/migrations/add_maint_notify_dispatch_rpc.sql` |
| `maint_enqueue_notification` | `sql/migrations/add_maint_notification_outbox.sql` |
| `maint_has_floor_read_access` | `sql/migrations/add_maintenance_module.sql` |
| `maint_incidents_enqueue_notify` | `sql/migrations/add_maint_notification_outbox.sql` |
| `maint_is_erp_admin` | `sql/migrations/add_maintenance_module.sql` |
| `maint_is_erp_admin_or_management` | `sql/migrations/add_maint_machine_hard_delete.sql` |
| `maint_machine_delete_hard` | `sql/migrations/add_maint_machine_hard_delete.sql` |
| `maint_machine_rename` | `sql/migrations/add_maint_rls_menadzment_paritet.sql` |
| `maint_machine_visible` | `sql/migrations/add_maintenance_module.sql` |
| `maint_machines_import_from_cache` | `sql/migrations/add_maint_rls_menadzment_paritet.sql` |
| `maint_notification_retry` | `sql/migrations/add_maint_rls_menadzment_paritet.sql` |
| `maint_profile_role` | `sql/migrations/add_maintenance_module.sql` |
| `salary_payroll_set_created_by` | `sql/migrations/add_kadr_salary_payroll.sql` |
| `touch_updated_at` | `sql/migrations/add_plan_proizvodnje.sql` |
| `update_updated_at` | `sql/migrations/add_kadrovska_phase1.sql` |
| `user_roles_set_updated_at` | `sql/migrations/add_admin_roles.sql` |

## 4. RLS politike po tabeli

Legenda flag-ova:
- `USING(true)` — politika ne filtrira ništa (svi authenticated vide / pišu sve).
- `TO anon` — politika se primenjuje na anon rolu.
- `no-USING` — politika nema USING klauzulu (samo INSERT smene smiju biti bez USING-a).

### `absences`

| Politika | Akcija | Role | USING | WITH CHECK | Flagovi | Izvor |
|---|---|---|---|---|---|---|
| `absences_delete` | DELETE | `authenticated` | `has_edit_role()` | `` | ✅ | `sql/migrations/add_kadrovska_phase1.sql` |
| `absences_insert` | INSERT | `authenticated` | `` | `has_edit_role()` | ✅ | `sql/migrations/add_kadrovska_phase1.sql` |
| `absences_select` | SELECT | `authenticated` | `true` | `` | ⚠ USING(true) | `sql/migrations/add_kadrovska_phase1.sql` |
| `absences_update` | UPDATE | `authenticated` | `has_edit_role()` | `has_edit_role()` | ✅ | `sql/migrations/add_kadrovska_phase1.sql` |

### `akcioni_plan`

| Politika | Akcija | Role | USING | WITH CHECK | Flagovi | Izvor |
|---|---|---|---|---|---|---|
| `ap_write` | ALL | `authenticated` | `public.has_edit_role()` | `public.has_edit_role()` | ✅ | `sql/migrations/add_sastanci_module.sql` |
| `ap_select` | SELECT | `authenticated` | `LOWER(COALESCE(odgovoran_email, '')) = LOWER(COALESCE(auth.…` | `` | ✅ | `sql/migrations/harden_sastanci_rls_phase2.sql` |

### `bigtehn_drawings_cache`

| Politika | Akcija | Role | USING | WITH CHECK | Flagovi | Izvor |
|---|---|---|---|---|---|---|
| `bdc_read_authenticated` | SELECT | `authenticated` | `TRUE` | `` | ⚠ USING(true) | `sql/migrations/add_bigtehn_drawings.sql` |

### `contracts`

| Politika | Akcija | Role | USING | WITH CHECK | Flagovi | Izvor |
|---|---|---|---|---|---|---|
| `contracts_delete` | DELETE | `authenticated` | `has_edit_role()` | `` | ✅ | `sql/migrations/add_kadrovska_phase1.sql` |
| `contracts_insert` | INSERT | `authenticated` | `` | `has_edit_role()` | ✅ | `sql/migrations/add_kadrovska_phase1.sql` |
| `contracts_select` | SELECT | `authenticated` | `true` | `` | ⚠ USING(true) | `sql/migrations/add_kadrovska_phase1.sql` |
| `contracts_update` | UPDATE | `authenticated` | `has_edit_role()` | `has_edit_role()` | ✅ | `sql/migrations/add_kadrovska_phase1.sql` |

### `employee_children`

| Politika | Akcija | Role | USING | WITH CHECK | Flagovi | Izvor |
|---|---|---|---|---|---|---|
| `employee_children_delete` | DELETE | `authenticated` | `public.current_user_is_hr_or_admin()` | `` | ✅ | `sql/migrations/add_kadr_employee_extended.sql` |
| `employee_children_insert` | INSERT | `authenticated` | `` | `public.current_user_is_hr_or_admin()` | ✅ | `sql/migrations/add_kadr_employee_extended.sql` |
| `employee_children_select` | SELECT | `authenticated` | `public.current_user_is_hr_or_admin()` | `` | ✅ | `sql/migrations/add_kadr_employee_extended.sql` |
| `employee_children_update` | UPDATE | `authenticated` | `public.current_user_is_hr_or_admin()` | `public.current_user_is_hr_or_admin()` | ✅ | `sql/migrations/add_kadr_employee_extended.sql` |

### `employees`

| Politika | Akcija | Role | USING | WITH CHECK | Flagovi | Izvor |
|---|---|---|---|---|---|---|
| `employees_delete` | DELETE | `authenticated` | `has_edit_role()` | `` | ✅ | `sql/migrations/add_kadrovska_module.sql` |
| `employees_insert` | INSERT | `authenticated` | `` | `has_edit_role()` | ✅ | `sql/migrations/add_kadrovska_module.sql` |
| `employees_select` | SELECT | `authenticated` | `true` | `` | ⚠ USING(true) | `sql/migrations/add_kadrovska_module.sql` |
| `employees_update` | UPDATE | `authenticated` | `has_edit_role()` | `has_edit_role()` | ✅ | `sql/migrations/add_kadrovska_module.sql` |

### `kadr_holidays`

| Politika | Akcija | Role | USING | WITH CHECK | Flagovi | Izvor |
|---|---|---|---|---|---|---|
| `kadr_holidays_delete_admin` | DELETE | `authenticated` | `public.current_user_is_admin()` | `` | ✅ | `sql/migrations/add_kadr_holidays.sql` |
| `kadr_holidays_insert_admin` | INSERT | `authenticated` | `` | `public.current_user_is_admin()` | ✅ | `sql/migrations/add_kadr_holidays.sql` |
| `kadr_holidays_select` | SELECT | `authenticated` | `true` | `` | ⚠ USING(true) | `sql/migrations/add_kadr_holidays.sql` |
| `kadr_holidays_update_admin` | UPDATE | `authenticated` | `public.current_user_is_admin()` | `public.current_user_is_admin()` | ✅ | `sql/migrations/add_kadr_holidays.sql` |

### `kadr_notification_config`

| Politika | Akcija | Role | USING | WITH CHECK | Flagovi | Izvor |
|---|---|---|---|---|---|---|
| `kadr_cfg_select_hr` | SELECT | `authenticated` | `public.current_user_is_hr_or_admin()` | `` | ✅ | `sql/migrations/add_kadr_notifications.sql` |
| `kadr_cfg_update_hr` | UPDATE | `authenticated` | `public.current_user_is_hr_or_admin()` | `public.current_user_is_hr_or_admin()` | ✅ | `sql/migrations/add_kadr_notifications.sql` |

### `kadr_notification_log`

| Politika | Akcija | Role | USING | WITH CHECK | Flagovi | Izvor |
|---|---|---|---|---|---|---|
| `kadr_notif_delete_hr` | DELETE | `authenticated` | `public.current_user_is_hr_or_admin()` | `` | ✅ | `sql/migrations/add_kadr_notifications.sql` |
| `kadr_notif_select_hr` | SELECT | `authenticated` | `public.current_user_is_hr_or_admin()` | `` | ✅ | `sql/migrations/add_kadr_notifications.sql` |
| `kadr_notif_update_hr` | UPDATE | `authenticated` | `public.current_user_is_hr_or_admin()` | `public.current_user_is_hr_or_admin()` | ✅ | `sql/migrations/add_kadr_notifications.sql` |

### `loc_item_placements`

| Politika | Akcija | Role | USING | WITH CHECK | Flagovi | Izvor |
|---|---|---|---|---|---|---|
| `loc_placements_select` | SELECT | `authenticated` | `true` | `` | ⚠ USING(true) | `sql/migrations/add_loc_module.sql` |

### `loc_location_movements`

| Politika | Akcija | Role | USING | WITH CHECK | Flagovi | Izvor |
|---|---|---|---|---|---|---|
| `loc_mov_select` | SELECT | `authenticated` | `true` | `` | ⚠ USING(true) | `sql/migrations/add_loc_module.sql` |

### `loc_locations`

| Politika | Akcija | Role | USING | WITH CHECK | Flagovi | Izvor |
|---|---|---|---|---|---|---|
| `loc_locations_insert` | INSERT | `authenticated` | `` | `public.loc_can_manage_locations()` | ✅ | `sql/migrations/add_loc_module.sql` |
| `loc_locations_select` | SELECT | `authenticated` | `true` | `` | ⚠ USING(true) | `sql/migrations/add_loc_module.sql` |
| `loc_locations_update` | UPDATE | `authenticated` | `public.loc_can_manage_locations()` | `public.loc_can_manage_locations()` | ✅ | `sql/migrations/add_loc_module.sql` |

### `loc_sync_outbound_events`

| Politika | Akcija | Role | USING | WITH CHECK | Flagovi | Izvor |
|---|---|---|---|---|---|---|
| `loc_sync_select` | SELECT | `authenticated` | `public.loc_is_admin()` | `` | ✅ | `sql/migrations/add_loc_module.sql` |

### `phases`

| Politika | Akcija | Role | USING | WITH CHECK | Flagovi | Izvor |
|---|---|---|---|---|---|---|
| `phases_delete` | DELETE | `authenticated` | `has_edit_role(project_id)` | `` | ✅ | `sql/schema.sql` |
| `phases_insert` | INSERT | `authenticated` | `` | `has_edit_role(project_id)` | ✅ | `sql/schema.sql` |
| `phases_select` | SELECT | `authenticated` | `true` | `` | ⚠ USING(true) | `sql/schema.sql` |
| `phases_update` | UPDATE | `authenticated` | `has_edit_role(project_id)` | `has_edit_role(project_id)` | ✅ | `sql/schema.sql` |

### `pm_teme`

| Politika | Akcija | Role | USING | WITH CHECK | Flagovi | Izvor |
|---|---|---|---|---|---|---|
| `pmt_write` | ALL | `authenticated` | `public.has_edit_role()` | `public.has_edit_role()` | ✅ | `sql/migrations/add_sastanci_module.sql` |
| `pmt_select` | SELECT | `authenticated` | `LOWER(COALESCE(predlozio_email, '')) = LOWER(COALESCE(auth.…` | `` | ✅ | `sql/migrations/harden_sastanci_rls_phase2.sql` |

### `presek_aktivnosti`

| Politika | Akcija | Role | USING | WITH CHECK | Flagovi | Izvor |
|---|---|---|---|---|---|---|
| `pa_write` | ALL | `authenticated` | `public.has_edit_role()` | `public.has_edit_role()` | ✅ | `sql/migrations/add_sastanci_module.sql` |
| `pa_select` | SELECT | `authenticated` | `public.is_sastanak_ucesnik(sastanak_id) OR public.current_u…` | `` | ✅ | `sql/migrations/harden_sastanci_rls_phase2.sql` |

### `presek_slike`

| Politika | Akcija | Role | USING | WITH CHECK | Flagovi | Izvor |
|---|---|---|---|---|---|---|
| `ps_write` | ALL | `authenticated` | `public.has_edit_role()` | `public.has_edit_role()` | ✅ | `sql/migrations/add_sastanci_module.sql` |
| `ps_select` | SELECT | `authenticated` | `public.is_sastanak_ucesnik(sastanak_id) OR public.current_u…` | `` | ✅ | `sql/migrations/harden_sastanci_rls_phase2.sql` |

### `production_drawings`

| Politika | Akcija | Role | USING | WITH CHECK | Flagovi | Izvor |
|---|---|---|---|---|---|---|
| `pd_delete_admin_pm` | DELETE | `authenticated` | `public.can_edit_plan_proizvodnje()` | `` | ✅ | `sql/migrations/add_plan_proizvodnje.sql` |
| `pd_insert_admin_pm` | INSERT | `authenticated` | `` | `public.can_edit_plan_proizvodnje()` | ✅ | `sql/migrations/add_plan_proizvodnje.sql` |
| `pd_read_authenticated` | SELECT | `authenticated` | `TRUE` | `` | ⚠ USING(true) | `sql/migrations/add_plan_proizvodnje.sql` |
| `pd_update_admin_pm` | UPDATE | `authenticated` | `public.can_edit_plan_proizvodnje()` | `public.can_edit_plan_proizvodnje()` | ✅ | `sql/migrations/add_plan_proizvodnje.sql` |

### `production_overlays`

| Politika | Akcija | Role | USING | WITH CHECK | Flagovi | Izvor |
|---|---|---|---|---|---|---|
| `po_delete_admin_pm` | DELETE | `authenticated` | `public.can_edit_plan_proizvodnje()` | `` | ✅ | `sql/migrations/add_plan_proizvodnje.sql` |
| `po_insert_admin_pm` | INSERT | `authenticated` | `` | `public.can_edit_plan_proizvodnje()` | ✅ | `sql/migrations/add_plan_proizvodnje.sql` |
| `po_read_authenticated` | SELECT | `authenticated` | `TRUE` | `` | ⚠ USING(true) | `sql/migrations/add_plan_proizvodnje.sql` |
| `po_update_admin_pm` | UPDATE | `authenticated` | `public.can_edit_plan_proizvodnje()` | `public.can_edit_plan_proizvodnje()` | ✅ | `sql/migrations/add_plan_proizvodnje.sql` |

### `projects`

| Politika | Akcija | Role | USING | WITH CHECK | Flagovi | Izvor |
|---|---|---|---|---|---|---|
| `projects_delete` | DELETE | `authenticated` | `has_edit_role(id)` | `` | ✅ | `sql/schema.sql` |
| `projects_insert` | INSERT | `authenticated` | `` | `has_edit_role()` | ✅ | `sql/schema.sql` |
| `projects_select` | SELECT | `authenticated` | `true` | `` | ⚠ USING(true) | `sql/schema.sql` |
| `projects_update` | UPDATE | `authenticated` | `has_edit_role(id)` | `has_edit_role(id)` | ✅ | `sql/schema.sql` |

### `projekt_bigtehn_rn`

| Politika | Akcija | Role | USING | WITH CHECK | Flagovi | Izvor |
|---|---|---|---|---|---|---|
| `pbr_write` | ALL | `authenticated` | `public.has_edit_role()` | `public.has_edit_role()` | ✅ | `sql/migrations/add_sastanci_module.sql` |
| `pbr_select` | SELECT | `authenticated` | `true` | `` | ⚠ USING(true) | `sql/migrations/add_sastanci_module.sql` |

### `reminder_log`

| Politika | Akcija | Role | USING | WITH CHECK | Flagovi | Izvor |
|---|---|---|---|---|---|---|
| `reminder_insert` | INSERT | `authenticated` | `` | `has_edit_role(project_id)` | ✅ | `sql/schema.sql` |
| `reminder_select` | SELECT | `authenticated` | `true` | `` | ⚠ USING(true) | `sql/schema.sql` |
| `reminder_update` | UPDATE | `authenticated` | `has_edit_role(project_id)` | `has_edit_role(project_id)` | ✅ | `sql/schema.sql` |

### `salary_payroll`

| Politika | Akcija | Role | USING | WITH CHECK | Flagovi | Izvor |
|---|---|---|---|---|---|---|
| `salary_payroll_delete_admin` | DELETE | `authenticated` | `public.current_user_is_admin()` | `` | ✅ | `sql/migrations/add_kadr_salary_payroll.sql` |
| `salary_payroll_insert_admin` | INSERT | `authenticated` | `` | `public.current_user_is_admin()` | ✅ | `sql/migrations/add_kadr_salary_payroll.sql` |
| `salary_payroll_select_admin` | SELECT | `authenticated` | `public.current_user_is_admin()` | `` | ✅ | `sql/migrations/add_kadr_salary_payroll.sql` |
| `salary_payroll_update_admin` | UPDATE | `authenticated` | `public.current_user_is_admin()` | `public.current_user_is_admin()` | ✅ | `sql/migrations/add_kadr_salary_payroll.sql` |

### `salary_terms`

| Politika | Akcija | Role | USING | WITH CHECK | Flagovi | Izvor |
|---|---|---|---|---|---|---|
| `salary_terms_delete_admin` | DELETE | `authenticated` | `public.current_user_is_admin()` | `` | ✅ | `sql/migrations/add_kadr_salary_terms.sql` |
| `salary_terms_insert_admin` | INSERT | `authenticated` | `` | `public.current_user_is_admin()` | ✅ | `sql/migrations/add_kadr_salary_terms.sql` |
| `salary_terms_select_admin` | SELECT | `authenticated` | `public.current_user_is_admin()` | `` | ✅ | `sql/migrations/add_kadr_salary_terms.sql` |
| `salary_terms_update_admin` | UPDATE | `authenticated` | `public.current_user_is_admin()` | `public.current_user_is_admin()` | ✅ | `sql/migrations/add_kadr_salary_terms.sql` |

### `sastanak_arhiva`

| Politika | Akcija | Role | USING | WITH CHECK | Flagovi | Izvor |
|---|---|---|---|---|---|---|
| `sa_write` | ALL | `authenticated` | `public.has_edit_role()` | `public.has_edit_role()` | ✅ | `sql/migrations/add_sastanci_module.sql` |
| `sa_select` | SELECT | `authenticated` | `public.is_sastanak_ucesnik(sastanak_id) OR public.current_u…` | `` | ✅ | `sql/migrations/harden_sastanci_rls_phase2.sql` |

### `sastanak_ucesnici`

| Politika | Akcija | Role | USING | WITH CHECK | Flagovi | Izvor |
|---|---|---|---|---|---|---|
| `su_write` | ALL | `authenticated` | `public.has_edit_role()` | `public.has_edit_role()` | ✅ | `sql/migrations/add_sastanci_module.sql` |
| `su_select` | SELECT | `authenticated` | `public.is_sastanak_ucesnik(sastanak_id) OR public.current_u…` | `` | ✅ | `sql/migrations/harden_sastanci_rls_phase2.sql` |

### `sastanci`

| Politika | Akcija | Role | USING | WITH CHECK | Flagovi | Izvor |
|---|---|---|---|---|---|---|
| `sastanci_write` | ALL | `authenticated` | `public.has_edit_role()` | `public.has_edit_role()` | ✅ | `sql/migrations/add_sastanci_module.sql` |
| `sastanci_select` | SELECT | `authenticated` | `public.is_sastanak_ucesnik(id) OR public.current_user_is_ma…` | `` | ✅ | `sql/migrations/harden_sastanci_rls_phase2.sql` |

### `user_roles`

| Politika | Akcija | Role | USING | WITH CHECK | Flagovi | Izvor |
|---|---|---|---|---|---|---|
| `user_roles_admin_write` | ALL | `authenticated` | `public.current_user_is_admin()` | `public.current_user_is_admin()` | ✅ | `sql/migrations/fix_user_roles_rls_recursion.sql` |
| `user_roles_read_admin_all` | SELECT | `authenticated` | `public.current_user_is_admin()` | `` | ✅ | `sql/migrations/fix_user_roles_rls_recursion.sql` |
| `user_roles_read_self` | SELECT | `authenticated` | `LOWER(email) = LOWER(COALESCE(auth.jwt() ->> 'email', ''))` | `` | ✅ | `sql/migrations/fix_user_roles_rls_recursion.sql` |

### `vacation_entitlements`

| Politika | Akcija | Role | USING | WITH CHECK | Flagovi | Izvor |
|---|---|---|---|---|---|---|
| `vac_ent_delete` | DELETE | `authenticated` | `has_edit_role()` | `` | ✅ | `sql/migrations/add_kadr_employee_extended.sql` |
| `vac_ent_insert` | INSERT | `authenticated` | `` | `has_edit_role()` | ✅ | `sql/migrations/add_kadr_employee_extended.sql` |
| `vac_ent_select` | SELECT | `authenticated` | `true` | `` | ⚠ USING(true) | `sql/migrations/add_kadr_employee_extended.sql` |
| `vac_ent_update` | UPDATE | `authenticated` | `has_edit_role()` | `has_edit_role()` | ✅ | `sql/migrations/add_kadr_employee_extended.sql` |

### `work_hours`

| Politika | Akcija | Role | USING | WITH CHECK | Flagovi | Izvor |
|---|---|---|---|---|---|---|
| `work_hours_delete` | DELETE | `authenticated` | `has_edit_role()` | `` | ✅ | `sql/migrations/add_kadrovska_phase1.sql` |
| `work_hours_insert` | INSERT | `authenticated` | `` | `has_edit_role()` | ✅ | `sql/migrations/add_kadrovska_phase1.sql` |
| `work_hours_select` | SELECT | `authenticated` | `true` | `` | ⚠ USING(true) | `sql/migrations/add_kadrovska_phase1.sql` |
| `work_hours_update` | UPDATE | `authenticated` | `has_edit_role()` | `has_edit_role()` | ✅ | `sql/migrations/add_kadrovska_phase1.sql` |

### `work_packages`

| Politika | Akcija | Role | USING | WITH CHECK | Flagovi | Izvor |
|---|---|---|---|---|---|---|
| `wp_delete` | DELETE | `authenticated` | `has_edit_role(project_id)` | `` | ✅ | `sql/schema.sql` |
| `wp_insert` | INSERT | `authenticated` | `` | `has_edit_role(project_id)` | ✅ | `sql/schema.sql` |
| `wp_select` | SELECT | `authenticated` | `true` | `` | ⚠ USING(true) | `sql/schema.sql` |
| `wp_update` | UPDATE | `authenticated` | `has_edit_role(project_id)` | `has_edit_role(project_id)` | ✅ | `sql/schema.sql` |

## 5. Statistika rizika

- Politike sa `USING(true)` (osim INSERT): **17**
- Politike sa `TO anon`: **0**
- Anon objekt grant-ovi (sa SELECT/INSERT/UPDATE/DELETE): **2**

## 6. Verifikacija sa žive baze

Ova matrica je izvedena iz SQL koda. Za pravu sliku sa Supabase produkcije:

```sql
-- Sve aktivne politike:
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
FROM   pg_policies
WHERE  schemaname = 'public'
ORDER  BY tablename, policyname;

-- Sve grant-ove na osetljivim objektima:
SELECT grantee, table_name, privilege_type
FROM   information_schema.role_table_grants
WHERE  table_schema = 'public' AND grantee IN ('anon','authenticated')
ORDER  BY table_name, grantee, privilege_type;
```

