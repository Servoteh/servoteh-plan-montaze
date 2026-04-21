# hr-notify-dispatch

Edge function koja obrađuje `kadr_notification_log` outbox — šalje WhatsApp / email
upozorenja o:

- isteku lekarskog pregleda (`medical_expiring`)
- isteku ugovora o radu (`contract_expiring`)
- rođendanima (opciono)
- godišnjicama rada (opciono)

## Zavisnost

SQL migracija **`sql/migrations/add_kadr_notifications.sql`** mora biti pokrenuta
u Supabase SQL editoru PRE deploy-a.

## Deploy

```bash
supabase functions deploy hr-notify-dispatch --no-verify-jwt
```

## Env secrets (Supabase Dashboard → Edge Functions → hr-notify-dispatch → Secrets)

| Name                        | Opis                                           | Default             |
| --------------------------- | ---------------------------------------------- | ------------------- |
| `WA_ACCESS_TOKEN`           | Meta Cloud API access token                    | (ako nema → DRY-RUN)|
| `WA_PHONE_NUMBER_ID`        | Meta WhatsApp `phone_number_id`                | —                   |
| `WA_TEMPLATE_NAME`          | Ime approved WhatsApp template-a (npr. `hr_alert_sr`) | —            |
| `WA_TEMPLATE_LANG`          | Jezik template-a                               | `sr`                |
| `RESEND_API_KEY`            | Resend.com API key za email                    | (DRY-RUN bez njega) |
| `RESEND_FROM`               | Pošiljalac email-a                             | `noreply@servoteh.rs` |
| `HR_DISPATCH_BATCH`         | Batch size                                     | `25`                |

> **Bez postavljenih tokena** funkcija radi u DRY-RUN režimu — redovi se
> obeležavaju kao `sent` i poruka se samo loguje u console. Tako možeš da
> testiraš schedule + UI bez slanja pravih poruka.

## Ručno slanje

```bash
curl -X POST "https://<PROJECT>.supabase.co/functions/v1/hr-notify-dispatch" \
     -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```

## Cron (preporučeno: Supabase Scheduled Trigger)

1. Dashboard → **Database → Cron Jobs** → New job.
2. Schedule: `*/5 * * * *` (svakih 5 min).
3. SQL:

    ```sql
    SELECT net.http_post(
      url     := 'https://<PROJECT>.supabase.co/functions/v1/hr-notify-dispatch',
      headers := jsonb_build_object(
        'Authorization', 'Bearer <SERVICE_ROLE_KEY>',
        'Content-Type',  'application/json'
      )
    );
    ```

## WhatsApp template (Meta Business Manager)

Template mora biti **approved** da bi se mogao slati van 24h konteksta.
Preporučena struktura sa 2 parametra:

- Name: `hr_alert_sr`
- Category: `UTILITY`
- Body:

    ```
    {{1}}
    {{2}}
    ```

gde je `{{1}}` = subject, `{{2}}` = body (koje šalje edge funkcija).

## Troubleshooting

```sql
-- Koliko je trenutno u queue
SELECT status, count(*) FROM kadr_notification_log GROUP BY status;

-- Poslednji failed + error poruke
SELECT id, recipient, subject, error, attempts, last_attempt_at
  FROM kadr_notification_log
 WHERE status = 'failed'
 ORDER BY last_attempt_at DESC NULLS LAST
 LIMIT 20;

-- Ručno resetuj failed → queued (retry)
UPDATE kadr_notification_log
   SET status='queued', next_attempt_at=now(), error=NULL
 WHERE status='failed';
```
