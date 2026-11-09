# Lalamove integration: implementation and setup

Implemented 2026-11-09. The user has confirmed that the database schema is migrated and the sandbox API keys work; those are accepted as ready and were not reverified. Sandbox bookings are now enabled in the local backend `.env`. Restart the backend to load changed environment settings. Local status updates already work through the polling worker; push callbacks require a public HTTPS tunnel or a deployed backend. The user's `https://hy-ops-backend.onrender.com/` URL is the deployed production backend and has not been used for local sandbox webhook registration. Automated tests use a fake provider and disposable local PostgreSQL; no live courier booking was submitted by this work.

## What now works

- Orders persist `delivery_method` through creation and grouped submissions. The method can be changed before scheduling when there is no competing fulfillment claim.
- The scheduling wizard's Lalamove selection links each selected order to `/panel/lalamove?orderId=<id>`. It does not create an internal run or spend money automatically. The departure entered in that wizard is not a scheduled provider pickup; this release books immediate, single-order jobs.
- The page loads the saved warehouse/customer route, configures warehouse pickup contacts, selects city/vehicle service, reviews a stored quotation and requires package suitability confirmation before booking.
- Only `SCHEDULING` orders with reserved stock can book. Existing processing/readiness actions still issue the invoice. Default eligible payment arrangements are `FULLY_PAID` and `NET_30`; `PAY_ON_DELIVERY` is always blocked. Enabling partial payment is an explicit server configuration decision, not courier cash collection.
- Booking attempts persist before the outbound POST. Repeated confirmation keys return the same attempt; conflicting payloads/active attempts are rejected. Lost responses remain `UNKNOWN` and block rebooking.
- Driver matching preserves reservations; pickup consumes them once; completion closes the order and queues the existing SMS/email completion outbox without inventing fleet stops. Merchandise receipts/refunds are unchanged.
- Signed v3 callbacks are durably deduplicated and processed by a worker. Processing reads authoritative provider state, avoiding stale event status transitions. Provider replacement IDs remain aliases of one local attempt. A canceled job remains held for review unless cancellation was explicitly confirmed by HYOps or an administrator reconciles it.
- The panel exposes booking history, cost, safe tracking links, courier details, POD status, status/cost change history, refresh, cancellation and administrator reconciliation. Unmatched/failed events appear in the administrator event queue and can be retried.
- Internal scheduling rejects external claims, including group races. Mobile driver trip/history/proof/dispatch/outcome access excludes external assignments; the Flutter app requires no new provider SDK or credentials. New Lalamove records live outside internal fleet tables.
- Delivery/order reports include production external jobs through reporting projections. Sandbox jobs are excluded from financial/delivery metrics. Provider costs remain separate from merchandise revenue. External delivery date basis is booking creation time in Manila; cost is treated as approved after completion, and only PHP costs enter existing PHP totals.

## Configure and migrate

1. The user has already migrated this environment. Do not reapply the old integration migration: the migration history has been consolidated into `src/db/migrations/0000_large_hobgoblin.sql`; older scripts are retained under `src/db/__migrations/`. The isolated test runner resolves archived scripts to exercise upgrades without modifying the application database. For future deployments, use the current migration journal and the appropriate environment-specific package command.
2. Set backend-only configuration (also documented in `.env.example`):

   ```dotenv
   LALAMOVE_ENABLED=true
   LALAMOVE_BASE_URL=https://rest.sandbox.lalamove.com
   LALAMOVE_MARKET=PH
   LALAMOVE_API_KEY=<sandbox pk_test credential>
   LALAMOVE_API_SECRET=<sandbox sk_test credential>
   LALAMOVE_WEBHOOK_PATH=/webhooks/lalamove
   LALAMOVE_WEBHOOK_URL=https://<your-public-backend>/webhooks/lalamove
   LALAMOVE_PAYMENT_ARRANGEMENTS=FULLY_PAID,NET_30
   ```

3. Verify warehouse coordinates and order destination snapshots. On the order's Lalamove page, save a real warehouse pickup contact and international phone number. Local PH mobile numbers are normalized. Existing bookings retain their saved contact snapshot.
4. Set the public HTTPS callback in `LALAMOVE_WEBHOOK_URL`, then open **Lalamove deliveries → Webhook setup** as an administrator and click **Register sandbox webhook**, or register the same URL directly in Partner Portal. Select **webhook event version v3** and the sandbox environment in Partner Portal. If a reverse proxy exposes `/api/webhooks/lalamove`, set the URL and `LALAMOVE_WEBHOOK_PATH` to that public path; the internal backend route remains `/webhooks/lalamove`. If `LALAMOVE_WEBHOOK_PATH` is omitted, the verifier derives it from the URL. A mismatch fails explicitly instead of accepting an incorrectly signed callback. Localhost cannot receive callbacks from Lalamove; local development needs a public HTTPS tunnel or deployed backend.
5. Sandbox bookings are enabled; keys are already tested by the user. The administrator setup panel displays the configured callback and the last authenticated callback received. Registration only runs after the explicit button action and is denied to staff/driver accounts. To exercise the full application workflow, staff can use an eligible saved order, review a quotation, and explicitly confirm booking; no extra credential test is required by the application setup workflow.
6. For production, separately configure the production host, `pk_prod`/`sk_prod` credentials, wallet/account readiness and webhook registration. Confirm fee ownership, vehicle capacity, credit terms, exception owners and data retention before enabling bookings. Do not mix active sandbox and production work in one operational deployment.

The provider adapter always uses v3; the old `LALAMOVE_VERSION` setting is no longer used. It accepts only official API hosts, signs the exact serialized request body, times out requests and never automatically retries booking POSTs. Secrets stay in backend configuration. Logs show correlation/provider reference IDs rather than raw customer/provider payloads.

## Recovery and operating limits

- Keep the backend worker running; it starts/stops with the application and coordinates replicas using a PostgreSQL advisory lock. It processes events in bounded batches and sweeps stale known bookings every minute. Failed events use bounded exponential backoff and move to `REVIEW` after the retry limit.
- Local development does not need a webhook to book or track: the worker refreshes stale known bookings automatically, normally within 2–3 minutes after the previous synchronization. The booking's **Refresh status** action requests current provider state sooner. A localhost backend needs a public HTTPS tunnel only to receive provider push events; the deployed Render URL does not forward callbacks into a local process.
- A process interruption leaves an active durable attempt; after two minutes, a stale `CREATING` attempt becomes `UNKNOWN`. No worker submits a booking POST. Find the real provider job in Partner Portal/support and link its ID using administrator reconciliation. The backend verifies provider metadata against the existing local attempt before linking.
- A known active job must be canceled/refreshed rather than released manually. For an unknown job with no ID, an administrator can release the attempt only after documenting evidence that no active/replacement courier exists. False manual resolution can create real duplicate courier work; the system cannot infer an undocumented provider lookup.
- A pre-pickup cancellation releases no merchandise stock reservation or payment. Rebooking is explicit. Delayed events for resolved terminal attempts cannot reclaim the order.
- After pickup, custody exceptions remain blocked for staff investigation. This release does not automatically restock, refund, create a courier return booking or assign the courier to the HYOps driver app. Reconcile physical goods and accounting through the business's controlled inventory/return process before any subsequent fulfillment.
- POD references and pickup/edit/code events are retained in restricted provider/event records; the standard panel shows POD status rather than exposing evidence files or delivery codes. Evidence file download, customer courier-fee charging/refunds, priority fees, driver-change controls, order edits, route optimization, scheduled/multi-stop bookings and automatic rebooking remain outside this release.
- Choose a customer-data retention policy for saved routes, contacts, provider responses and event payloads before launch. No automatic deletion policy is assumed. Alert on `UNKNOWN`/`REVIEW`, stale active jobs, worker failures, provider throttling and callback disablement in Partner Portal.
- To pause new bookings, set `LALAMOVE_ENABLED=false` while keeping credentials, callback ingestion and workers available for existing jobs. `externalIntegrations=false` is a test/offline switch that disables the integration entirely; it is not the production drain switch.
- Lalamove limits historical provider reads. Preserve local records and use Portal/support when an old unresolved job is no longer queryable.

## Verification

### Saved pickup warehouses

The Lalamove order page uses the shared `PaginatedCombobox` to select a saved, active warehouse with server-side search and pages of ten. The order's stock warehouse is the default pickup. An administrator can select another pickup warehouse; staff can select only their assigned warehouse. The selection is persisted in `orders.lalamove_pickup_warehouse_id` and does not change `orders.warehouse_id` or move reserved inventory. Operations must ensure the goods are available at the selected pickup location.

New quotations and bookings use the selected warehouse's name, full address, verified coordinates, and `phone_number`. Manage the phone number in the warehouse create/edit form. A complete address, valid coordinates, and a phone number accepted by the existing international-phone normalization are required before selecting a different warehouse or requesting a quotation. Selection changes use the order version, invalidate previous quotations, and are blocked for scheduled orders and active/unresolved delivery claims. Existing courier bookings retain the route and contact snapshot used at confirmation.

Apply `src/db/migrations/0001_cuddly_chronomancer.sql` through the normal Drizzle migration workflow before running this change against an existing database (`bun run db:migrate` for the configured development database). It adds `warehouses.phone_number`, backfills existing pickup phone values that fit the new field, and adds the optional pickup warehouse foreign key to orders. The implementation does not apply migrations to the user's database automatically. Legacy pickup contact columns are retained for compatibility; the new booking flow uses `phone_number` and the warehouse name.

`GET /lalamove/context/:id/warehouses?page=0&search=...` supplies scoped options. `PUT /lalamove/context/:id/warehouse` accepts `{ warehouse_id, version }`. Archived or deleted warehouses cannot be selected; warehouse deletion/archive checks account for pickup references.

- `bun run test` in backend: existing unit suites plus the Lalamove suite; database cases skip without the dedicated test URL.
- `bun run test:db`: disposable PostgreSQL migration and existing transaction/driver/return/WebSocket regressions.
- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-database.ps1 -Suite Lalamove`: 21 passing tests, including pickup warehouse selection, phone CRUD/listing persistence, search pagination, staff scope, stale versions, route/quote invalidation and the existing adapter, lifecycle and fulfillment safeguards. New asynchronous rejection checks explicitly await the operation before checking the error, avoiding a stall in Bun's rejection matcher with repeated database calls.
- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-database.ps1 -Suite Live -BrowserFilter Lalamove`: 5 passing Chromium tests with mocked provider-facing responses, including warehouse search/pagination, missing-phone feedback, save progress/errors, reload persistence, explicit booking and cancellation confirmation, administrator settings and mobile layout.
- Backend TypeScript check passes with the repository-compatible module settings: `bun ../frontend/node_modules/typescript/bin/tsc --noEmit --module preserve --moduleResolution bundler`.
- Frontend unit tests: 41 pass. Targeted Lalamove lint passes. The inventory description contract and notification warning styling type errors have been corrected. Existing repository-wide backend lint has unrelated failures; the new Lalamove modules pass targeted lint.
- Frontend production build passes with `HYOPS_BUILD_DIR=.next-build-check` and `next build --webpack`, including type checks and static generation. The font stack uses locally available Inter or system sans-serif fonts, removing the Google Fonts build download. An invalid named export on the experimental `test-6` page was also corrected. `HYOPS_BUILD_DIR` supports isolated build output; normal builds still default to `.next`.

## Official sources

- [Lalamove API reference](https://developers.lalamove.com/)
- [Official webhook tutorial, April 2026](https://van-static.lalamove.com/developers-doc/1011500/files/v3_Webhook_v1.5.pdf)

The webhook verifier signs the serialized `data` field using the envelope timestamp and the registered public path. It does not sign the entire HTTP body. The outer event label is used for diagnostics; order mutations always follow an authenticated provider lookup.
