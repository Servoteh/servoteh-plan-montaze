/**
 * Supabase Edge Function: pb-notify-dispatch
 *
 * Dispatch worker za public.pb_notification_log (Projektni biro).
 * Deploy: supabase functions deploy pb-notify-dispatch --no-verify-jwt
 *
 * Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY (opciono), RESEND_FROM
 */

// deno-lint-ignore-file no-explicit-any
// @ts-ignore Deno runtime
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';

type PbRow = {
  id: string;
  channel: string;
  recipient: string;
  subject: string | null;
  body: string;
  attempts: number;
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const RESEND_FROM = Deno.env.get('RESEND_FROM') ?? 'Projektni biro <noreply@servoteh.rs>';
const BATCH = Number(Deno.env.get('PB_DISPATCH_BATCH') ?? '10') || 10;

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
    console.error(`[pb-dispatch rpc ${fn}]`, res.status, await res.text());
    return null;
  }
  const txt = await res.text();
  if (!txt) return null;
  try {
    return JSON.parse(txt) as T;
  } catch {
    return null;
  }
}

async function sendEmail(row: PbRow): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!RESEND_API_KEY) {
    console.log('[pb-dispatch DRY-RUN email]', row.recipient);
    return { ok: true };
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
      subject: row.subject ?? 'Projektni biro',
      text: row.body,
    }),
  });
  if (res.ok) return { ok: true };
  return { ok: false, error: `Resend ${res.status}: ${(await res.text()).slice(0, 800)}` };
}

serve(async (req) => {
  const audit = req.headers.get('x-audit-actor') ?? 'anonymous';
  console.log('[pb-notify-dispatch] actor:', audit);

  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!SERVICE_ROLE || token !== SERVICE_ROLE) {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (req.method !== 'POST' && req.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const batch = await rpc<PbRow[]>('pb_dispatch_dequeue', { batch_size: BATCH });
    const rows = Array.isArray(batch) ? batch : [];
    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const row of rows) {
      try {
        if (row.channel === 'whatsapp') {
          console.warn('[pb-dispatch] WhatsApp not configured for PB — marking sent');
          await rpc('pb_dispatch_mark_sent', { p_id: row.id });
          skipped++;
          continue;
        }
        if (row.channel === 'email') {
          const r = await sendEmail(row);
          if (r.ok) {
            await rpc('pb_dispatch_mark_sent', { p_id: row.id });
            sent++;
          } else {
            await rpc('pb_dispatch_mark_failed', {
              p_id: row.id,
              p_error: 'error' in r ? r.error : 'send failed',
            });
            failed++;
          }
          continue;
        }
        await rpc('pb_dispatch_mark_sent', { p_id: row.id });
        skipped++;
      } catch (e) {
        failed++;
        await rpc('pb_dispatch_mark_failed', {
          p_id: row.id,
          p_error: String(e).slice(0, 900),
        });
      }
    }

    return new Response(JSON.stringify({ ok: true, sent, failed, skipped, processed: rows.length }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  } catch (e) {
    console.error('[pb-dispatch] fatal', e);
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
});
