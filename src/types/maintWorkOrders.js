/**
 * JSDoc tipovi za `maint_work_orders` i povezane enum vrednosti (šema: add_maint_work_orders.sql).
 * Aplikacija je vanilla JS — ovo daje podsetnike u IDE.
 *
 * Puni `Database` tip iz baze: `npm run gen:db-types` (zahteva lokalni Supabase ili `--linked` projekat).
 *
 * @module types/maintWorkOrders
 */

/**
 * @typedef {'kvar' | 'preventiva' | 'inspekcija' | 'servis' | 'administrativni'} MaintWoType
 */

/**
 * @typedef {'p1_zastoj' | 'p2_smetnja' | 'p3_manje' | 'p4_planirano'} MaintWoPriority
 */

/**
 * @typedef {'machine' | 'vehicle' | 'it' | 'facility'} MaintAssetType
 */

/**
 * @typedef {'novi' | 'potvrden' | 'dodeljen' | 'u_radu' | 'ceka_deo' | 'ceka_dobavljaca' | 'ceka_korisnika' | 'kontrola' | 'zavrsen' | 'otkazan'} MaintWoStatus
 */

/**
 * Red iz `public.maint_work_orders` (PostgREST / sbReq).
 * @typedef {{
 *   wo_id: string,
 *   wo_number: string | null,
 *   type: MaintWoType,
 *   asset_id: string,
 *   asset_type: MaintAssetType | string,
 *   source_incident_id: string | null,
 *   source_preventive_task_id: string | null,
 *   title: string,
 *   description: string | null,
 *   priority: MaintWoPriority,
 *   safety_marker: boolean,
 *   status: MaintWoStatus,
 *   reported_by: string,
 *   assigned_to: string | null,
 *   due_at: string | null,
 *   created_at: string,
 *   started_at: string | null,
 *   completed_at: string | null,
 *   downtime_from: string | null,
 *   downtime_to: string | null,
 *   labor_minutes: number | null,
 *   cost_total: string | null,
 *   closure_comment: string | null,
 *   updated_at: string,
 *   updated_by: string | null,
 *   maint_assets?: { asset_code: string, name: string, asset_type?: string } | null
 * }} MaintWorkOrderRow
 */

/**
 * Ugnježdeni `maint_work_orders` na incidentu (PostgREST embed).
 * @typedef {{ wo_id: string, wo_number: string | null, status: string, title: string, priority?: string } | null} MaintWorkOrderStub
 */

export {};
