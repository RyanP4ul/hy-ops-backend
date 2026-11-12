# Synced driver stop planning

Apply `src/db/migrations/0001_driver_stop_plan.sql` before deploying the updated
backend. Deploy the web changes and rebuild the mobile app to enable this flow.
The migration only adds a nullable JSON column to `deliveries`.

The mobile app posts `{ "action": "skip" }` or `{ "action": "next" }` to
`POST /driver/stops/:id/plan`. Only the assigned driver can change a pending
grouped order while the internal trip is in transit. Commands lock the delivery
row, merge with the saved plan, and increment its version. Stop outcomes,
payments, stock, and trip completion are unaffected.

Driver trip responses include `stopPlan` with `nextStopId` and `skippedStopIds`.
Fleet responses include `skippedForNow` and `deliverNext` on stops. Completed
stops and plans saved by another driver are ignored. The fleet map keeps skipped
orders pending, displays their skipped badge, and routes to the selected next
eligible stop. When all pending orders are skipped, it has no next destination
until an order is resumed.

Committed changes publish the existing `hyops_resource_changed` and
`hyops_driver_changed` notifications so web queries and other mobile devices
refresh. Reconnect and polling also reload authoritative state. Changes require
an online connection; cached trip data remains readable offline. Older
device-only preferences are no longer applied; drivers should reselect any
existing skips after upgrading.
