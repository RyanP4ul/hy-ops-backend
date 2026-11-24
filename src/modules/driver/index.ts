import { CustomerReturnService } from "../deliveries/customer-returns";
import { DeliveryService } from "../deliveries/service";
import { IncidentService } from "../incidents/service";
import { proofService } from "./proofs";
import { vehicleService } from "../vehicles/service";
import Elysia, { t } from "elysia";
import { AuthUser } from "../auth/schema";
import { DriverService } from "./service";
import { settingService } from "../settings/service";
import { operationReceipt, syncCapabilities } from "./sync-receipts";

const pagination = t.Object({ page: t.Optional(t.Numeric({ minimum: 0, maximum: 100000, multipleOf: 1 })), pageSize: t.Optional(t.Numeric({ minimum: 1, maximum: 50, multipleOf: 1 })), past: t.Optional(t.Union([t.Literal("true"), t.Literal("false")])) });
const historyQuery = t.Object({ ...pagination.properties, from: t.Optional(t.String({ format: "date" })), to: t.Optional(t.String({ format: "date" })), status: t.Optional(t.Union([t.Literal("delivered"), t.Literal("failed"), t.Literal("cancelled")])) });
const params = t.Object({ id: t.Numeric({ minimum: 1, multipleOf: 1 }) });
const command = { version: t.Integer({ minimum: 1 }), operationKey: t.String({ format: "uuid" }) };

export function createDriverRoutes(proofs = proofService) { return new Elysia({ prefix: "/driver" }).decorate("user", {} as AuthUser)
  .get("/sync/capabilities", syncCapabilities, { detail: { tags: ["Drivers"] } })
  .get("/sync/operations/:key", ({ user, params }) => operationReceipt(Number(user.sub), params.key), {
    params: t.Object({ key: t.String({ format: "uuid" }) }), detail: { tags: ["Drivers"] } })
  .post("/returns/:id/collected", ({ user, params, body }) => CustomerReturnService.collect(Number(user.sub), params.id, body), {
      detail: { summary: 'Create returns by id collected', description: 'POST endpoint for returns by id collected in the drivers module.', tags: ['Drivers'] }, params, body: t.Object({ ...command, tripVersion: t.Optional(t.Integer({ minimum: 1 })) }) })
  .post("/returns/:id/failed", ({ user, params, body }) => CustomerReturnService.fail(Number(user.sub), params.id, body), {
      detail: { summary: 'Record failed customer return pickup', description: 'Mark an assigned customer return pickup as failed with a reason so the trip can proceed.', tags: ['Drivers'] }, params, body: t.Object({ ...command, reason: t.String({ minLength: 1, maxLength: 500 }), tripVersion: t.Optional(t.Integer({ minimum: 1 })) }) })
  .get("/returns/:id/proofs", ({ user, params }) => proofs.listReturnProofs(user, params.id), {
      detail: { summary: 'List return pickup proofs', description: 'List uploaded photo/signature proofs of collection for a return pickup.', tags: ['Drivers'] }, params })
  .get("/returns/:id/proofs/:proofId", ({ user, params }) => proofs.downloadReturnProof(user, params.id, params.proofId), {
      detail: { summary: 'Download return pickup proof', description: 'Download a proof-of-collection file for a return pickup.', tags: ['Drivers'] }, params: t.Object({ id: t.Numeric({ minimum: 1 }), proofId: t.String({ format: "uuid" }) }) })
  .post("/returns/:id/proofs", ({ user, params, body }) => proofs.uploadReturnProof(Number(user.sub), params.id, body.file, body.kind, body.operationKey), {
      detail: { summary: 'Upload return pickup proof', description: 'Upload a photo or customer handover signature for a customer return pickup.', tags: ['Drivers'] }, params, body: t.Object({ file: t.File({ maxSize: 5 * 1024 * 1024 }), kind: t.Union([t.Literal("photo"), t.Literal("signature")]), operationKey: t.String({ format: "uuid" }) }) })
  .post("/vehicle-issues", ({ user, body }) => vehicleService.reportDriverVehicleIssue(Number(user.sub), body), {
      detail: { summary: 'Report a vehicle issue or odometer reading', description: 'Allow an assigned driver to report a mechanical issue and/or odometer update to warehouse staff.', tags: ['Drivers'] },
      body: t.Object({
        delivery_id: t.Optional(t.Integer({ minimum: 1 })),
        vehicle_id: t.Optional(t.Integer({ minimum: 1 })),
        maintenance_type: t.Optional(t.Union([
          t.Literal("preventive"),
          t.Literal("repair"),
          t.Literal("tire_battery"),
          t.Literal("inspection"),
          t.Literal("breakdown"),
        ])),
        title: t.String({ minLength: 1, maxLength: 160 }),
        description: t.Optional(t.Nullable(t.String({ maxLength: 1000 }))),
        odometer_km: t.Optional(t.Nullable(t.Numeric({ minimum: 0 }))),
      }) })
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
  .get("/trips/:id/incidents", ({ user, params }) => IncidentService.listDriverTripIncidents(Number(user.sub), params.id), {
      detail: { summary: 'List incidents reported for a driver trip', tags: ['Drivers', 'Incidents'] }, params })
  .post("/trips/:id/incidents", ({ user, params, body }) => IncidentService.createIncident({ delivery_id: params.id, ...body }, { id: Number(user.sub), role: "driver" }), {
      detail: { summary: 'Report a transit incident on an assigned trip', tags: ['Drivers', 'Incidents'] },
      params,
      body: t.Object({
        stop_id: t.Optional(t.Nullable(t.Integer({ minimum: 1 }))),
        category: t.Union([
          t.Literal("DELAY"),
          t.Literal("TRAFFIC"),
          t.Literal("BREAKDOWN"),
          t.Literal("ACCIDENT"),
          t.Literal("WEATHER"),
          t.Literal("OTHER"),
        ]),
        severity: t.Optional(
          t.Union([
            t.Literal("low"),
            t.Literal("medium"),
            t.Literal("high"),
            t.Literal("critical"),
          ]),
        ),
        description: t.String({ minLength: 1, maxLength: 1000 }),
        status_notes: t.Optional(t.Nullable(t.String({ maxLength: 1000 }))),
        estimated_delay_minutes: t.Optional(
          t.Nullable(t.Integer({ minimum: 0, maximum: 1440 })),
        ),
        latitude: t.Optional(t.Nullable(t.Number({ minimum: -90, maximum: 90 }))),
        longitude: t.Optional(
          t.Nullable(t.Number({ minimum: -180, maximum: 180 })),
        ),
      }) })
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
  .post("/stops/:id/plan", ({ user, params, body }) => DriverService.planStop(Number(user.sub), params.id, body.action), {
    params, body: t.Object({ action: t.Union([t.Literal("skip"), t.Literal("next")]) }),
    detail: { summary: "Skip or prioritize a pending grouped order", tags: ["Drivers"] } })
  .post("/stops/:id/failed", ({ user, params, body }) => DriverService.outcome(Number(user.sub), params.id, body, "failed"), {
      detail: { summary: 'Create stops by id failed', description: 'POST endpoint for stops by id failed in the drivers module.', tags: ['Drivers'] }, params, body: t.Object({ ...command, reason: t.String({ minLength: 1, maxLength: 500 }) }) });

}
export const driverRoutes = createDriverRoutes();
