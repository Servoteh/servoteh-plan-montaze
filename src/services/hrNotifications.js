/**
 * HR notifikacije (Faza K4) — FE service layer za `kadr_notification_log`
 * i singleton `kadr_notification_config`.
 *
 * Prava: SELECT/UPDATE/DELETE — HR/admin (RLS).
 * Insert redova ide ISKLJUČIVO kroz SECURITY DEFINER schedule funkciju.
 */

import { sbReq } from './supabase.js';
import { isHrOrAdmin, getIsOnline } from '../state/auth.js';

/* ── CONFIG (singleton) ──────────────────────────────────────────── */

function mapDbConfig(c) {
  return {
    id: c.id,
    enabled: !!c.enabled,
    medicalLeadDays: Number(c.medical_lead_days ?? 30),
    contractLeadDays: Number(c.contract_lead_days ?? 30),
    birthdayEnabled: !!c.birthday_enabled,
    workAnniversaryEnabled: !!c.work_anniversary_enabled,
    whatsappRecipients: Array.isArray(c.whatsapp_recipients) ? c.whatsapp_recipients : [],
    emailRecipients: Array.isArray(c.email_recipients) ? c.email_recipients : [],
    updatedAt: c.updated_at || null,
    updatedBy: c.updated_by || '',
  };
}

export async function loadHrNotifConfig() {
  if (!getIsOnline() || !isHrOrAdmin()) return null;
  const data = await sbReq('kadr_notification_config?id=eq.1&select=*&limit=1');
  if (!data || !data.length) return null;
  return mapDbConfig(data[0]);
}

export async function updateHrNotifConfig(cfg) {
  if (!getIsOnline() || !isHrOrAdmin()) return null;
  const payload = {
    enabled: !!cfg.enabled,
    medical_lead_days: Number(cfg.medicalLeadDays ?? 30),
    contract_lead_days: Number(cfg.contractLeadDays ?? 30),
    birthday_enabled: !!cfg.birthdayEnabled,
    work_anniversary_enabled: !!cfg.workAnniversaryEnabled,
    whatsapp_recipients: Array.isArray(cfg.whatsappRecipients) ? cfg.whatsappRecipients : [],
    email_recipients: Array.isArray(cfg.emailRecipients) ? cfg.emailRecipients : [],
    updated_at: new Date().toISOString(),
  };
  const res = await sbReq('kadr_notification_config?id=eq.1', 'PATCH', payload);
  if (!res || !res.length) return null;
  return mapDbConfig(res[0]);
}

/* ── OUTBOX LOG ──────────────────────────────────────────────────── */

function mapDbLog(r) {
  return {
    id: r.id,
    channel: r.channel,
    recipient: r.recipient,
    subject: r.subject || '',
    body: r.body || '',
    relatedEntityType: r.related_entity_type || '',
    relatedEntityId: r.related_entity_id || null,
    employeeId: r.employee_id || null,
    notificationType: r.notification_type,
    status: r.status,
    scheduledAt: r.scheduled_at || null,
    nextAttemptAt: r.next_attempt_at || null,
    attempts: Number(r.attempts || 0),
    lastAttemptAt: r.last_attempt_at || null,
    sentAt: r.sent_at || null,
    error: r.error || '',
    payload: r.payload || {},
    createdAt: r.created_at || null,
    updatedAt: r.updated_at || null,
  };
}

/**
 * Lista log redova. `filter.status` može biti 'queued'|'sent'|'failed'|'canceled'|'all'.
 * Vraća najviše `limit` redova (default 200).
 */
export async function loadHrNotifLog({ status = 'all', limit = 200 } = {}) {
  if (!getIsOnline() || !isHrOrAdmin()) return null;
  const params = ['select=*', `order=scheduled_at.desc.nullslast,created_at.desc`, `limit=${limit}`];
  if (status && status !== 'all') params.push(`status=eq.${encodeURIComponent(status)}`);
  const data = await sbReq(`kadr_notification_log?${params.join('&')}`);
  if (!data) return null;
  return data.map(mapDbLog);
}

/** Ručno otkazivanje pojedinačnog reda (status → 'canceled'). */
export async function cancelHrNotif(id) {
  if (!getIsOnline() || !isHrOrAdmin() || !id) return false;
  const res = await sbReq(
    `kadr_notification_log?id=eq.${encodeURIComponent(id)}`,
    'PATCH',
    { status: 'canceled', updated_at: new Date().toISOString() },
  );
  return !!res;
}

/** Ručno vraćanje failed reda u queue za novi pokušaj. */
export async function retryHrNotif(id) {
  if (!getIsOnline() || !isHrOrAdmin() || !id) return false;
  const res = await sbReq(
    `kadr_notification_log?id=eq.${encodeURIComponent(id)}`,
    'PATCH',
    { status: 'queued', next_attempt_at: new Date().toISOString(), error: null },
  );
  return !!res;
}

/** Brisanje (trajno). */
export async function deleteHrNotif(id) {
  if (!getIsOnline() || !isHrOrAdmin() || !id) return false;
  return (await sbReq(
    `kadr_notification_log?id=eq.${encodeURIComponent(id)}`,
    'DELETE',
  )) !== null;
}

/**
 * Ručno pokreni schedule funkciju preko autorizovanog wrapper-a
 * `kadr_trigger_schedule_hr_reminders()`.
 * Vraća { scheduledCount, skippedCount, configMissing } ili null.
 */
export async function triggerScheduleHrReminders() {
  if (!getIsOnline() || !isHrOrAdmin()) return null;
  const data = await sbReq(
    'rpc/kadr_trigger_schedule_hr_reminders',
    'POST',
    {},
  );
  if (!data || !data.length) return null;
  const r = data[0];
  return {
    scheduledCount: Number(r.scheduled_count || 0),
    skippedCount: Number(r.skipped_count || 0),
    configMissing: !!r.config_missing,
  };
}
