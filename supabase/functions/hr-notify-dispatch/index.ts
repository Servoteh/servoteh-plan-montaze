/**
 * Supabase Edge Function: `hr-notify-dispatch`
 *
 * Batch dispatch worker za outbox `public.kadr_notification_log`.
 * Pokreće ga Supabase Scheduled Trigger (npr. svakih 5 min) ili ručno
 * iz UI-ja preko `kadr_trigger_schedule_hr_reminders()`.
 *
 * Tok:
 *   1) `kadr_dispatch_dequeue(batch_size, max_attempts)` lock-uje batch.
 *   2) Za svaki red:
 *      • channel = 'whatsapp' → Meta Cloud API (ako su env vars postavljene,
 *        inače DRY-RUN u console log).
 *      • channel = 'email'    → Resend / SMTP (ako je RESEND_API_KEY
 *        postavljen, inače DRY-RUN).
 *      • ostali kanali → DRY-RUN.
 *   3) Mark sent / failed (+ exponential backoff).
 *
 * Env varijable (Supabase Secrets):
 *   SUPABASE_URL                 (auto)
 *   SUPABASE_SERVICE_ROLE_KEY    (auto)
 *   WA_ACCESS_TOKEN              (opciono)
 *   WA_PHONE_NUMBER_ID           (opciono)
 *   WA_TEMPLATE_NAME             (opciono; npr. "hr_alert_sr")
 *   WA_TEMPLATE_LANG             (default: "sr")
 *   RESEND_API_KEY               (opciono; za email kanal)
 *   RESEND_FROM                  (default: "noreply@example.com")
 *   HR_DISPATCH_BATCH            (default: 25)
 *
 * Deploy:
 *   supabase functions deploy hr-notify-dispatch --no-verify-jwt
 *
 * Cron (Supabase Dashboard → Database → Cron Jobs):
 *   */5 * * * *   SELECT net.http_post(
 *       url := 'https://<project>.supabase.co/functions/v1/hr-notify-dispatch',
 *       headers := jsonb_build_object('Authorization', 'Bearer <SERVICE_ROLE>')
 *     );
 */

// deno-lint-ignore-file no-explicit-any
// @ts-ignore Deno runtime
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';

type HrNotificationRow = {
  id: string;
  channel: 'whatsapp' | 'email' | 'sms';
  recipient: string;
  subject: string | null;
  body: string;
  related_entity_type: string | null;
  related_entity_id: string | null;
  employee_id: string | null;
  notification_type: string;
  attempts: number;
  payload: Record<string, unknown> | null;
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const WA_ACCESS_TOKEN = Deno.env.get('WA_ACCESS_TOKEN') ?? '';
const WA_PHONE_NUMBER_ID = Deno.env.get('WA_PHONE_NUMBER_ID') ?? '';
const WA_TEMPLATE_NAME = Deno.env.get('WA_TEMPLATE_NAME') ?? '';
const WA_TEMPLATE_LANG = Deno.env.get('WA_TEMPLATE_LANG') ?? 'sr';
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const RESEND_FROM = Deno.env.get('RESEND_FROM') ?? 'noreply@servoteh.rs';
const BATCH = Number(Deno.env.get('HR_DISPATCH_BATCH') ?? '25') || 25;
const MAX_ATTEMPTS = 8;

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('[hr-dispatch] Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
}

async function rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T | null> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      Prefer: 'return=representation',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    console.error(`[rpc ${fn}] ${res.status} ${await res.text()}`);
    return null;
  }
  const txt = await res.text();
  if (!txt) return null;
  try { return JSON.parse(txt) as T; } catch { return null; }
}

function backoffSeconds(attempts: number): number {
  /* 5 min, 10 min, 20 min, ..., cap 6h */
  return Math.min(300 * Math.pow(2, Math.max(0, attempts - 1)), 6 * 60 * 60);
}

async function sendWhatsApp(row: HrNotificationRow) {
  if (!WA_ACCESS_TOKEN || !WA_PHONE_NUMBER_ID || !WA_TEMPLATE_NAME) {
    console.log('[DRY-RUN whatsapp]', row.recipient, '::', row.subject, '::', row.body);
    return { ok: true as const };
  }
  const payload = {
    messaging_product: 'whatsapp',
    to: row.recipient,
    type: 'template',
    template: {
      name: WA_TEMPLATE_NAME,
      language: { code: WA_TEMPLATE_LANG },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: row.subject ?? '' },
            { type: 'text', text: row.body ?? '' },
          ],
        },
      ],
    },
  };
  const res = await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${WA_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });
  if (res.ok) return { ok: true as const };
  return { ok: false as const, error: `WA ${res.status}: ${(await res.text()).slice(0, 800)}` };
}

async function sendEmail(row: HrNotificationRow) {
  if (!RESEND_API_KEY) {
    console.log('[DRY-RUN email]', row.recipient, '::', row.subject, '::', row.body);
    return { ok: true as const };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [row.recipient],
      subject: row.subject ?? 'HR obaveštenje',
      text: row.body,
    }),
  });
  if (res.ok) return { ok: true as const };
  return { ok: false as const, error: `Resend ${res.status}: ${(await res.text()).slice(0, 800)}` };
}

async function dispatchOne(row: HrNotificationRow) {
  if (row.channel === 'whatsapp') return await sendWhatsApp(row);
  if (row.channel === 'email')    return await sendEmail(row);
  /* SMS i drugi kanali — DRY-RUN za sada. */
  console.log(`[DRY-RUN ${row.channel}]`, row.recipient, '::', row.body);
  return { ok: true as const };
}

async function runBatch() {
  const batch = await rpc<HrNotificationRow[]>('kadr_dispatch_dequeue', {
    p_batch_size: BATCH,
    p_max_attempts: MAX_ATTEMPTS,
  });
  if (!batch || batch.length === 0) {
    return { processed: 0, sent: 0, failed: 0 };
  }
  const sentIds: string[] = [];
  let failed = 0;

  for (const row of batch) {
    try {
      const res = await dispatchOne(row);
      if (res.ok) {
        sentIds.push(row.id);
      } else {
        failed++;
        await rpc('kadr_dispatch_mark_failed', {
          p_id: row.id,
          p_error: res.error ?? 'unknown',
          p_backoff_sec: backoffSeconds(row.attempts + 1),
        });
      }
    } catch (e) {
      failed++;
      await rpc('kadr_dispatch_mark_failed', {
        p_id: row.id,
        p_error: String(e).slice(0, 900),
        p_backoff_sec: backoffSeconds(row.attempts + 1),
      });
    }
  }

  if (sentIds.length) {
    await rpc('kadr_dispatch_mark_sent', { p_ids: sentIds });
  }

  return { processed: batch.length, sent: sentIds.length, failed };
}

serve(async (req) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  try {
    const result = await runBatch();
    return new Response(JSON.stringify({ ok: true, ...result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  } catch (e) {
    console.error('[hr-dispatch] fatal', e);
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
});
