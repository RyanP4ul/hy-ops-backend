# HyOps backend

The backend is an Elysia API running on Bun. It uses PostgreSQL through
Drizzle ORM, HTTP-only JWT cookies for authentication, and a websocket endpoint
for live dashboard updates.

## Requirements

- Bun
- PostgreSQL
- A database named for the application, with a connection string in `DB_URL`

## Setup

1. Install dependencies:

   ```bash
   bun install
   ```

2. Create `.env` with values appropriate for your environment:

   ```env
   NODE_ENV=development
   DB_URL=postgres://user:password@localhost:5432/hyops
   FRONTEND_URL=http://localhost:3000
   JWT_SECRET=replace-with-a-long-random-secret
   REFRESH_TOKEN_SECRET=replace-with-a-different-long-random-secret

   LALAMOVE_BASE_URL=https://rest.sandbox.lalamove.com
   LALAMOVE_VERSION=v3
   LALAMOVE_API_KEY=replace-with-your-key
   LALAMOVE_API_SECRET=replace-with-your-secret
   LALAMOVE_MARKET=PH
   ```

   Never commit real credentials to source control.

3. Apply the database schema:

   ```bash
   bun run db:migrate
   ```

   To load development seed data, run `bun run db:seed`.

4. Start the API:

   ```bash
   bun run dev
   ```

The API listens on `http://localhost:5173`.

## Available scripts

| Command | Description |
| --- | --- |
| `bun run dev` | Start the API with file watching |
| `bun run build` | Compile the Bun server binary |
| `bun run lint` | Run Oxlint |
| `bun run db:generate` | Generate a Drizzle migration |
| `bun run db:migrate` | Apply migrations |
| `bun run db:push` | Push the schema directly to the database |
| `bun run db:studio` | Open Drizzle Studio |
| `bun run db:seed` | Seed development data |

## Authentication

`POST /auth/login` sets the `access_token` and `refresh_token` HTTP-only
cookies. All module routes require a valid access token. WebSocket upgrades
accept either an access-token cookie (native clients) or a single-use browser
ticket. `POST /auth/refresh` issues a new access token, and
`POST /auth/logout` clears both cookies.

The frontend accesses these endpoints through its `/api/*` rewrite, for
example `/api/auth/login`.

### WebSockets on Vercel and Render

The browser logs in through Vercel's `/api/*` rewrite, so its HTTP-only cookies
belong to the frontend host. They are not sent to the separate Render host.
Before every connection or reconnect, the frontend posts to
`/api/auth/ws-ticket` with its cookies. The authenticated backend issues a
random ticket valid for 30 seconds and the browser connects directly to
`wss://<backend>/ws?ticket=...`. PostgreSQL stores only the ticket hash and
the validated session claims; atomic redemption prevents reuse across instances.
The socket retains the original access-token expiry and session revocation checks.

Deploy in this order:

1. Apply `src/db/migrations/0003_ws_tickets.sql` to the backend database through
   your normal migration process (`bun run db:migrate` for a database already
   tracked by this migration history).
2. Set Render's `NODE_ENV=production` and
   `APP_ORIGINS=https://hy-ops-frontend.vercel.app`. Origins are comma-separated
   exact origins without trailing slashes. If `APP_ORIGINS` is empty,
   `FRONTEND_URL` is used before the local development defaults.
3. Deploy the backend, then rebuild and deploy the frontend with
   `NEXT_PUBLIC_BACKEND_URL=https://hy-ops-backend.onrender.com` and
   `NEXT_PUBLIC_WS_URL=wss://hy-ops-backend.onrender.com/ws`.
4. Sign in and verify `/api/auth/ws-ticket` returns 200, the WebSocket upgrade
   returns 101, and the socket receives `WS_READY`.

Do not log ticket query parameters in reverse-proxy or access logs. The backend
request logger records the pathname only. A missing cookie on a ticket-authenticated
WebSocket request is expected.

Run the database/socket regression checks with
`powershell -File scripts/test-database.ps1 -Suite Driver`. Run the browser
ticket and reconnect checks with
`powershell -File scripts/test-database.ps1 -Suite Live -BrowserFilter 'WebSocket tickets'`.
Both commands create disposable loopback databases.

## HTTP routes

### Realtime mobile delivery assignments

Run the normal `bun run db:migrate` deployment step to apply
`src/db/migrations/0004_driver_assignment_events.sql`. This installs an idempotent
assignment trigger in the production migration history, including installations
that already used the legacy `_migrations/0007_driver_history_proofs.sql` trigger.
After a delivery transaction commits, PostgreSQL notifies the backend, which
sends `DRIVER_ASSIGNMENT_CHANGED` only to that driver's authenticated devices.
Creation and reassignment use `kind: assigned`; previous owners receive
`removed`, and cancellation or schedule edits receive their corresponding event.
Rolled-back schedules send no event. Use a direct/session PostgreSQL connection
that supports `LISTEN/NOTIFY` for the backend listener.

The mobile app immediately reconciles its current deliveries, shows an in-app
banner, and reconciles again after reconnect/resume. These are foreground app
notifications, not operating-system push notifications for a closed app.
Verify with `powershell -File scripts/test-database.ps1 -Suite Realtime`; it uses
a disposable local PostgreSQL database and real authenticated WebSockets.

All routes below, except the authentication routes, are protected by the
access-token guard.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/auth/me` | Return the current user |
| `POST` | `/auth/login` | Sign in |
| `POST` | `/auth/ws-ticket` | Issue a single-use ticket for an authenticated session |
| `POST` | `/auth/refresh` | Refresh the access token |
| `POST` | `/auth/logout` | Sign out |
| `GET` | `/products`, `/products/:id` | List and read products |
| `GET` | `/products/variant/:variant_id` | Read a product variant |
| `POST` | `/products` | Create a product |
| `PUT` | `/products/:id` | Update a product |
| `DELETE` | `/products/:id` | Delete a product |
| `GET` | `/product_variants` | List product variants |
| `GET`, `POST`, `PUT`, `DELETE` | `/inventory`, `/inventory/:id` | Manage inventory |
| `GET` | `/inventory/names`, `/inventory/details` | Inventory lookups |
| `GET`, `POST` | `/settings`, `/settings/names` | Read and update settings |
| `GET`, `POST`, `PUT`, `DELETE` | `/warehouses`, `/warehouses/:id` | Manage warehouses |
| `GET` | `/warehouses/names` | Warehouse lookup |
| `POST` | `/warehouses/:id/archive` | Archive a warehouse |
| `GET`, `POST`, `PUT`, `DELETE` | `/vehicles`, `/vehicles/:id` | Manage vehicles |
| `GET` | `/vehicles/cb` | Vehicle combobox lookup |
| `GET`, `POST`, `PUT`, `DELETE` | `/users`, `/users/:id` | Manage users |
| `GET` | `/users/customers`, `/users/drivers` | User lookups |
| `GET` | `/orders`, `/orders/:id` | List and read orders |
| `GET` | `/orders/details`, `/orders/cb` | Order lookups |
| `POST` | `/orders` | Create an order |
| `POST` | `/orders/process/:id` | Process an order |
| `POST` | `/orders/delivery/:id` | Mark an order for delivery |
| `POST` | `/orders/cancel/:id` | Cancel an order |
| `GET` | `/delivery-schedules`, `/delivery-schedules/available-dates` | Delivery scheduling |
| `GET`, `POST` | `/deliveries`, `/deliveries/event` | Create deliveries and delivery events |
| `GET`, `POST` | `/calendar/events`, `/calendar/event` | Read and create calendar events |
| `GET` | `/notifications` | List notifications |
| `POST` | `/notifications/mark-all-read` | Mark notifications as read |
| `GET` | `/sessions`, `/sessions/me`, `/sessions/logs` | Read sessions and logs |
| `DELETE` | `/sessions/:id` | Delete a session |
| `GET` | `/audit-logs` | Read audit logs |
| `GET` | `/archives` | List archived records |
| `PUT` | `/archives/:id/restore` | Restore an archived record |
| `GET` | `/geocode/search` | Search addresses |
| `GET` | `/lalamove/cities` | List Lalamove cities |
| `POST` | `/payments` | Create a payment |

Paginated endpoints return the total row count in the `X-Total-Count` response
header. Validation failures return status `400` with an `errors` object.

## Scheduled report archives

The backend automatically registers **Weekly Analysis & Reports** (Monday 06:00)
and **Monthly Analysis & Reports** (1st of the month 06:00), in `Asia/Manila`.
Both start enabled and appear in Automations with enable/disable and Run now controls.
Each run exports five Excel workbooks: sales, inventory, payment, delivery, and
customer. Workbooks contain analysis summaries, detail rows, and report metadata.
Weekly reports cover the previous completed Monday–Sunday week; monthly reports
cover the previous calendar month. Inventory is the current stock snapshot at
generation time, and payment balances follow the existing report definitions.

Files use the existing R2 connection (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`):

```text
weekly/2026-11-02_to_2026-11-08/sales-report.xlsx
monthly/2026-10-01_to_2026-10-31/sales-report.xlsx
```

The same folders also contain `inventory-report.xlsx`, `payment-report.xlsx`,
`delivery-report.xlsx`, and `customer-report.xlsx`. Keys stay stable on retries
and manual reruns. The backend must be running for scheduling; persisted due
times survive restarts. After downtime, one run captures the latest completed
period rather than backfilling every missed period. Failed runs retry after five
minutes and retain their error in Automations. Multiple replicas coordinate with
PostgreSQL advisory locks. `automation: false` or `externalIntegrations: false`
disables the report worker. No schema migration or reseeding is needed.

## Websocket connection

Connect to `ws://localhost:5173/ws` after authenticating. The websocket is used
for live session, notification, order, product, user, warehouse, and page-change
events. Request handlers are registered under `src/ws/requests`.

## Project structure

```text
src/index.ts              Elysia app, middleware, guards, and route mounting
src/modules/              Domain routes and services
src/api/                  Standalone API handlers
src/db/                   Drizzle schema, migrations, and seeds
src/plugins/              JWT and external-service integrations
src/ws/                   Websocket server and request handlers
```
