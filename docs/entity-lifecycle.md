# Entity status actions

Products, inventory, warehouses, vehicles and users support activation and
archiving as separate actions. Permanent deletion is requested from Archives and
performed automatically after a full 30-day grace period, subject to dependency
checks. Management lists provide Archive instead of immediate Delete.

| Entity | Activate/deactivate | Archive | Archived details/restore |
| --- | --- | --- | --- |
| Products | Supported | Supported | Archives view |
| Inventory | Supported | Supported | Archives view |
| Warehouses | Added | Existing route now uses shared lifecycle rules | Existing Archives view |
| Vehicles | Added independently of availability/maintenance | Added | Added to Archives |
| Users | Added independently of archiving | Existing action correctly labelled Archive | Existing Archives view |

## Behaviour

- Administrators manage lifecycle actions. Each mutation checks the current actor,
  token generation, entity version, and archived state inside a transaction.
- Inactive records remain in management directories with an Activate action.
  Archived entities leave those directories and remain in Archives and historical
  joins. Restoring returns a record **inactive**; activation is a separate action.
- Eligibility is derived from each record and its parents. Inventory requires an
  active product, active stock row, and active, unarchived warehouse. Vehicles and
  staff/driver operational access require an active, unarchived home warehouse.
  Disabling a parent never rewrites its children's explicit activation flags.
  Management rows show derived unavailability when a parent disables their use.
- Product variants, stock selectors, the walk-in catalog, stock summaries, reorder
  suggestions, current inventory reports, driver/vehicle selectors, fleet operations,
  and courier pickup selection apply the corresponding eligibility rules.
- Checkout, order reservation/consumption, stock creation/adjustment, scheduling,
  dispatch, and assignments validate status on the server. Cancelling orders can
  still release reservations, and historical orders/invoices/payments remain readable.
- Deactivation/archive is rejected while linked open orders, stock reservations,
  or scheduled/active trips exist. Warehouses with outstanding customer returns
  must receive those returns first. The system walk-in user and the acting
  administrator cannot be disabled through lifecycle actions.
- Account changes revoke tokens, clear refresh tokens and close live sessions after
  commit. Warehouse-dependent authentication and operational scope are checked
  against current warehouse state.
- Lifecycle mutations share the stock advisory barrier with checkout and scheduling,
  avoiding races between status changes and new operational use. Versions and audit
  entries are updated atomically. Relationships, quantities and historical records
  are retained.
- HTTP resource events invalidate related queries, including walk-in catalogs and
  cross-module selectors. The acting browser also invalidates cached queries after
  successful changes.
- Vehicle creation always saves `available`, including requests from older clients
  that supply a status. The Add Vehicle form hides Status; existing vehicles retain
  status editing. The vehicle image field is removed from forms, API models,
  queries, seed data and the database.

## Permanent deletion and retention

- Archiving only changes status and creates archive metadata. It never deletes the
  entity or automatically starts a deletion countdown.
- Delete in Archives opens a confirmation explaining the 30-day grace period.
  Confirming schedules deletion **30 days after that confirmation**, using the
  database clock. The list displays the authoritative scheduled date; the popup
  shows an estimated date until confirmation. Repeated requests preserve the date.
- A database constraint prohibits incomplete schedules and deadlines shorter than
  30 days. The worker independently checks archive time, request time, the deadline,
  and the current entity's archive state. There is no immediate-purge HTTP API.
- Restoring removes the archive entry and cancels any pending deletion, even when
  overdue. The restored entity remains inactive until explicitly activated.
- The retention worker runs on server startup and every minute when automation is
  enabled. It checks at most 25 due entries per sweep, prioritizing entries that have
  not recently been checked. Multiple backend instances cannot delete a row twice.
- Before deletion, the worker locks the archived entity and inspects **all inbound
  foreign keys**, including relationships configured with `CASCADE` or `SET NULL`.
  Product variants and user profiles/addresses are removed only as owned children
  that have no external dependencies. New foreign keys are discovered automatically.
- Non-zero stock, orders, deliveries, stock movements, audit history and other
  linked records prevent deletion. The archived row stays intact, the list shows
  the blocking reason, and later sweeps retry it. The worker never erases historical
  relationships just to meet a scheduled deadline.
- Purges, owned-child removal and audit entries commit atomically. Restore, archive,
  checkout and cleanup share transaction barriers; resource notifications occur
  after commit. Direct Delete APIs on management entities return HTTP 405.

## API

`POST /{products|inventory|warehouses|vehicles|users}/:id/activate` and
`POST /{resource}/:id/deactivate` accept `{ "version": 1 }`.

`POST /{products|inventory|vehicles}/:id/archive` accepts the same body. Existing warehouse/user archive
routes retain their `?version=1` contract. `PUT /archives/:id/restore` also supports
products, inventory and vehicles and cancels deletion schedules.
`DELETE /archives/:id` returns HTTP 202 with `delete_after` and schedules deletion;
it never immediately removes the record.
`GET /inventory?active_only=true` provides the filtered catalog while the
management inventory list remains available for activation/deactivation.

## Migration and verification

Apply `0001_archive_retention.sql` with the repository's migration command before
running the updated backend. This checkout's consolidated baseline already includes
activation fields. The new migration adds product/inventory archive flags,
retention metadata and its constraint/index, and drops `vehicles.image`.
No shared development or production database is changed by the tests.

Run from `backend`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-database.ps1 -Suite Lifecycle
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-database.ps1 -Suite LifecycleRegression
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-database.ps1 -Suite Retention
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-database.ps1 -Suite RetentionBrowser
bun run tests/run-tests.ts
```

The lifecycle suites create disposable loopback PostgreSQL databases, reconstruct
the columns preceding this migration, apply the migration, and test real service
and HTTP behaviour. The regression suite runs existing transaction workflows
against the current schema without requiring older fixture migrations that are
absent from this checkout.
