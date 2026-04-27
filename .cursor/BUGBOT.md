# Bugbot rules for this repository

Critical rules:

1. **Active predmet logic** — Do not change active predmet logic. The active predmet list must depend on `public.get_aktivni_predmeti()` and `production.predmet_aktivacija.je_aktivan = true`.

2. **MES / BigTehn work orders** — Do not add MES / `v_active_bigtehn_work_orders` condition to the active predmet list.

3. **Routes** — Do not break:
   - `/pracenje-proizvodnje`
   - `?predmet=`
   - `?rn=`
   - `#tab=po_pozicijama`
   - `#tab=operativni_plan`

4. **Production tracking report**
   - Completed quantity must come from final control.
   - Do not treat last operation as final control unless explicitly marked.
   - User notes must not be written to BigTehn cache.
   - Admin + management only can write notes.
   - Backend must enforce permissions, not only frontend.

5. **Exports** — Excel and PDF exports must use the same data model as the screen.

6. **Performance** — Avoid N+1 RPC/API calls.

7. **Secrets** — Never expose `service_role` keys or secrets in frontend code.
