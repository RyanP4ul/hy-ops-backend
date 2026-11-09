import Elysia, { t } from "elysia";
import { AuthUser } from "../auth/schema";
import { staffWarehouse } from "../deliveries/scope";
import { lalamoveRequest, requireLalamoveBooking } from "../../plugins/lalamove";
import { LalamoveService } from "./service";

const id = t.Object({ id: t.Numeric({ minimum: 1 }) });
const bookingId = t.Object({ bookingId: t.Numeric({ minimum: 1 }) });
export const lalamoveRoutes = new Elysia({ prefix: "/lalamove" }).decorate("user", {} as AuthUser)
  .get("/setup", ({ user }) => LalamoveService.setup(user))
  .post("/webhook/register", ({ user }) => LalamoveService.registerWebhook(user))
  .get("/reconciliation", ({ user }) => LalamoveService.reconciliation(user))
  .post("/events/:eventId/reconcile", ({ user, params }) => LalamoveService.retryEvent(params.eventId, user), { params: t.Object({ eventId: t.String({ format: "uuid" }) }) })
  .get("/eligible", ({ user }) => LalamoveService.eligible(user))
  .get("/cities", async ({ user }) => { await staffWarehouse(user); requireLalamoveBooking(); return lalamoveRequest("GET", "/cities"); })
  .get("/orders", ({ user, query }) => LalamoveService.list(user, query.page ?? 0), { query: t.Object({ page: t.Optional(t.Numeric({ minimum: 0, maximum: 10000 })) }) })
  .get("/context/:id", ({ params, user }) => LalamoveService.context(params.id, user), { params: id })
  .get("/context/:id/warehouses", ({ params, query, user }) => LalamoveService.pickupWarehouses(params.id, query.page ?? 0, query.search ?? "", user), {
    params: id, query: t.Object({ page: t.Optional(t.Numeric({ minimum: 0, maximum: 10000 })), search: t.Optional(t.String({ maxLength: 100 })) }) })
  .put("/context/:id/warehouse", ({ params, body, user }) => LalamoveService.setPickupWarehouse(params.id, body.version, body.warehouse_id, user), {
    params: id, body: t.Object({ version: t.Integer({ minimum: 1 }), warehouse_id: t.Integer({ minimum: 1 }) }) })
  .put("/context/:id/method", ({ params, body, user }) => LalamoveService.setMethod(params.id, body.version, body.method, user), {
    params: id, body: t.Object({ version: t.Integer({ minimum: 1 }), method: t.Union([t.Literal("INTERNAL"), t.Literal("PICKUP"), t.Literal("LALAMOVE")]) }) })
  .put("/context/:id/pickup", ({ params, body, user }) => LalamoveService.pickup(params.id, body.name, body.phone, user), {
    params: id, body: t.Object({ name: t.String({ minLength: 1, maxLength: 100, pattern: "\\S" }), phone: t.String({ maxLength: 20 }) }) })
  .post("/quotations", ({ body, user }) => LalamoveService.createQuotation(body, user), { body: t.Object({
    order_id: t.Integer({ minimum: 1 }), order_version: t.Integer({ minimum: 1 }), service_type: t.String({ minLength: 1, maxLength: 100 }), city: t.String({ minLength: 1, maxLength: 100 }) }) })
  .post("/orders", ({ body, user }) => LalamoveService.placeOrder(body, user), { body: t.Object({
    order_id: t.Integer({ minimum: 1 }), order_version: t.Integer({ minimum: 1 }), quotation_ref: t.String({ format: "uuid" }), idempotency_key: t.String({ format: "uuid" }), package_confirmed: t.Boolean() }) })
  .get("/orders/:bookingId", async ({ params, user }) => LalamoveService.summary(await LalamoveService.booking(params.bookingId, user)), { params: bookingId })
  .post("/orders/:bookingId/refresh", ({ params, user }) => LalamoveService.refresh(params.bookingId, user), { params: bookingId })
  .post("/orders/:bookingId/cancel", ({ params, user }) => LalamoveService.cancel(params.bookingId, user), { params: bookingId })
  .post("/orders/:bookingId/reconcile", ({ params, body, user }) => LalamoveService.resolve(params.bookingId, body.note, user, body.provider_order_id), {
    params: bookingId, body: t.Object({ note: t.String({ minLength: 15, maxLength: 2000 }), provider_order_id: t.Optional(t.String({ minLength: 1, maxLength: 100 })) }) });
