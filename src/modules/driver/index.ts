import { CustomerReturnService } from "../deliveries/customer-returns";
import { DeliveryService } from "../deliveries/service";
import { proofService } from "./proofs";
import Elysia, { t } from "elysia";
import { AuthUser } from "../auth/schema";
import { DriverService } from "./service";
import { settingService } from "../settings/service";

const pagination = t.Object({ page: t.Optional(t.Numeric({ minimum: 0, maximum: 100000, multipleOf: 1 })), pageSize: t.Optional(t.Numeric({ minimum: 1, maximum: 50, multipleOf: 1 })), past: t.Optional(t.Union([t.Literal("true"), t.Literal("false")])) });
const historyQuery = t.Object({ ...pagination.properties, from: t.Optional(t.String({ format: "date" })), to: t.Optional(t.String({ format: "date" })), status: t.Optional(t.Union([t.Literal("delivered"), t.Literal("failed"), t.Literal("cancelled")])) });
const params = t.Object({ id: t.Numeric({ minimum: 1, multipleOf: 1 }) });
const command = { version: t.Integer({ minimum: 1 }), operationKey: t.String({ format: "uuid" }) };

export function createDriverRoutes(proofs = proofService) { return new Elysia({ prefix: "/driver" }).decorate("user", {} as AuthUser)
  .post("/returns/:id/collected", ({ user, params, body }) => CustomerReturnService.collect(Number(user.sub), params.id, body), {
      detail: { summary: 'Create returns by id collected', description: 'POST endpoint for returns by id collected in the drivers module.', tags: ['Drivers'] }, params, body: t.Object(command) })
  .get("/profile", ({ user }) => DriverService.profile(Number(user.sub)), { detail: { summary: 'Get profile', description: 'GET endpoint for profile in the drivers module.', tags: ['Drivers'] } })
  .get("/settings", async () => {
    const [setting] = await settingService.getSettingByNames(["mobile_automatic_refresh_interval_ms"]);
    return { mobile_automatic_refresh_interval_ms: setting?.value ?? null };
  }, { detail: { summary: 'Get settings', description: 'GET endpoint for settings in the drivers module.', tags: ['Drivers'] } })
  .get("/trips", ({ user, query }) => DriverService.trips(Number(user.sub), query.page, query.pageSize, query.past === "true"), {
      detail: { summary: 'Get trips', description: 'GET endpoint for trips in the drivers module.', tags: ['Drivers'] }, query: pagination })
  .get("/trips/:id", ({ user, params }) => DriverService.trip(Number(user.sub), params.id), {
      detail: { summary: 'Get trips by id', description: 'GET endpoint for trips by id in the drivers module.', tags: ['Drivers'] }, params })
  .post("/trips/:id/start", ({ user, params, body }) => DeliveryService.dispatchDelivery(params.id, undefined, { driverId: Number(user.sub), version: body.version }), {
      detail: { summary: 'Create trips by id start', description: 'POST endpoint for trips by id start in the drivers module.', tags: ['Drivers'] }, params, body: t.Object({ version: t.Integer({ minimum: 1 }) }) })
  .get("/history", ({ user, query }) => DriverService.history(Number(user.sub), query.page, query.pageSize, query), {
      detail: { summary: 'Get history', description: 'GET endpoint for history in the drivers module.', tags: ['Drivers'] }, query: historyQuery })
  .get("/stops/:id/proofs", ({ user, params }) => proofs.list(user, params.id), {
      detail: { summary: 'Get stops by id proofs', description: 'GET endpoint for stops by id proofs in the drivers module.', tags: ['Drivers'] }, params })
  .get("/stops/:id/proofs/:proofId", ({ user, params }) => proofs.download(user, params.id, params.proofId), {
      detail: { summary: 'Get stops by id proofs by proofId', description: 'GET endpoint for stops by id proofs by proofId in the drivers module.', tags: ['Drivers'] }, params: t.Object({ id: t.Numeric({ minimum: 1 }), proofId: t.String({ format: "uuid" }) }) })
  .post("/stops/:id/proofs", ({ user, params, body }) => proofs.upload(Number(user.sub), params.id, body.file, body.kind, body.operationKey), {
      detail: { summary: 'Create stops by id proofs', description: 'POST endpoint for stops by id proofs in the drivers module.', tags: ['Drivers'] }, params, body: t.Object({ file: t.File({ maxSize: 5 * 1024 * 1024 }), kind: t.Union([t.Literal("photo"), t.Literal("signature")]), operationKey: t.String({ format: "uuid" }) }) })
  .post("/stops/:id/delivered", ({ user, params, body }) => DriverService.outcome(Number(user.sub), params.id, body, "delivered"), {
      detail: { summary: 'Create stops by id delivered', description: 'POST endpoint for stops by id delivered in the drivers module.', tags: ['Drivers'] }, params, body: t.Object(command) })
  .post("/stops/:id/failed", ({ user, params, body }) => DriverService.outcome(Number(user.sub), params.id, body, "failed"), {
      detail: { summary: 'Create stops by id failed', description: 'POST endpoint for stops by id failed in the drivers module.', tags: ['Drivers'] }, params, body: t.Object({ ...command, reason: t.String({ minLength: 1, maxLength: 500 }) }) });

}
export const driverRoutes = createDriverRoutes();
