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
cookies. All module routes and the websocket endpoint require a valid access
token. `POST /auth/refresh` issues a new access token, and
`POST /auth/logout` clears both cookies.

The frontend accesses these endpoints through its `/api/*` rewrite, for
example `/api/auth/login`.

## HTTP routes

All routes below, except the authentication routes, are protected by the
access-token guard.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/auth/me` | Return the current user |
| `POST` | `/auth/login` | Sign in |
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

## Websocket

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
