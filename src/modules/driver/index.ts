import { CustomerReturnService } from "../deliveries/customer-returns";
import { DeliveryService } from "../deliveries/service";
import { proofService } from "./proofs";
import Elysia, { t } from "elysia";
import { AuthUser } from "../auth/schema";
import { DriverService } from "./service";

const pagination = t.Object({ page: t.Optional(t.Numeric({ minimum: 0, maximum: 100000, multipleOf: 1 })), pageSize: t.Optional(t.Numeric({ minimum: 1, maximum: 50, multipleOf: 1 })), past: t.Optional(t.Union([t.Literal("true"), t.Literal("false")])) });
const historyQuery = t.Object({ ...pagination.properties, from: t.Optional(t.String({ format: "date" })), to: t.Optional(t.String({ format: "date" })), status: t.Optional(t.Union([t.Literal("delivered"), t.Literal("failed"), t.Literal("cancelled")])) });
const params = t.Object({ id: t.Numeric({ minimum: 1, multipleOf: 1 }) });
const command = { version: t.Integer({ minimum: 1 }), operationKey: t.String({ format: "uuid" }) };

export function createDriverRoutes(proofs = proofService) { return new Elysia({ prefix: "/driver" }).decorate("user", {} as AuthUser)
  .post("/returns/:id/collected", ({ user, params, body }) => CustomerReturnService.collect(Number(user.sub), params.id, body), { params, body: t.Object(command) })
  .get("/profile", ({ user }) => DriverService.profile(Number(user.sub)))
  .get("/trips", ({ user, query }) => DriverService.trips(Number(user.sub), query.page, query.pageSize, query.past === "true"), { query: pagination })
  .get("/trips/:id", ({ user, params }) => DriverService.trip(Number(user.sub), params.id), { params })
  .post("/trips/:id/start", ({ user, params, body }) => DeliveryService.dispatchDelivery(params.id, undefined, { driverId: Number(user.sub), version: body.version }), { params, body: t.Object({ version: t.Integer({ minimum: 1 }) }) })
  .get("/history", ({ user, query }) => DriverService.history(Number(user.sub), query.page, query.pageSize, query), { query: historyQuery })
  .get("/stops/:id/proofs", ({ user, params }) => proofs.list(user, params.id), { params })
  .get("/stops/:id/proofs/:proofId", ({ user, params }) => proofs.download(user, params.id, params.proofId), { params: t.Object({ id: t.Numeric({ minimum: 1 }), proofId: t.String({ format: "uuid" }) }) })
  .post("/stops/:id/proofs", ({ user, params, body }) => proofs.upload(Number(user.sub), params.id, body.file, body.kind, body.operationKey), { params, body: t.Object({ file: t.File({ maxSize: 5 * 1024 * 1024 }), kind: t.Union([t.Literal("photo"), t.Literal("signature")]), operationKey: t.String({ format: "uuid" }) }) })
  .post("/stops/:id/delivered", ({ user, params, body }) => DriverService.outcome(Number(user.sub), params.id, body, "delivered"), { params, body: t.Object(command) })
  .post("/stops/:id/failed", ({ user, params, body }) => DriverService.outcome(Number(user.sub), params.id, body, "failed"), { params, body: t.Object({ ...command, reason: t.String({ minLength: 1, maxLength: 500 }) }) });

}
export const driverRoutes = createDriverRoutes();
