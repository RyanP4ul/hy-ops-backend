import type { SmsGateway } from "./modules/sms/service";
import { startDeliveryNotificationWorker } from "./modules/deliveries/notification-worker";
import { startDriverEvents } from "./modules/driver/assignment-events";
import { authorizeClaims, allowedOrigin } from "./modules/auth/policy";
import { consumeWsTicket } from "./modules/auth/ws-ticket";
import type { ProofService } from "./modules/driver/proofs";
import { createDriverRoutes, driverRoutes } from "./modules/driver";
import { WorkflowError } from "./utils/workflow-error";
import { Elysia, t } from "elysia";
import { logger } from "./utils/logger";
import { authRoutes } from "./modules/auth";
import { authPlugin } from "./plugins/auth";
import { productRoutes } from "./modules/products";
import cors from "@elysia/cors";
import { ws } from "./ws";
import { auditTarget } from "./utils/audit";
import { TOPIC } from "./ws/topic";
import "./ws/requests";
import { requestManager } from "./ws/requests/request-manager";
import { inventoryRoutes } from "./modules/inventory";
import { sessionRoutes } from "./modules/session";
import { settingRoutes } from "./modules/settings";
import { warehouseRoutes } from "./modules/warehouse";
import { productVariantRoutes } from "./modules/product_variant";
import { notificationRoutes } from "./modules/notifications";
import { auditLogRoutes } from "./modules/audit_logs";
import { UserService } from "./modules/user/service";
import { userRoutes } from "./modules/user";
import { geocodeRoute } from "./api/geocode";
import { archivesRoutes } from "./modules/archives";
import { startAutomationTasks } from "./manager/automation-tasks";
import { vehicleRoutes } from "./modules/vehicles";
import { lalamoveRoutes } from "./modules/lalamove";
import { orderRoutes } from "./modules/order";
import { deliveryScheduleRoutes } from "./modules/delivery-schedule";
import { deliveriesRoutes } from "./modules/deliveries";
import { calendarRoutes } from "./modules/calendar";
import { paymentRoutes } from "./modules/payments";
import { dashboardRoutes } from "./modules/dashboard";
import { AuditLogService } from "./modules/audit_logs/service";
import { automationRoutes } from "./modules/automations";
import { createSmsRoutes } from "./modules/sms";
import { deliveryEstimateRoutes } from "./modules/delivery-expenses";
import { geocodingRoutes } from "./modules/geocode";
import { reportsModule } from "./modules/analysis-reports";
import { createEmailRoutes, type EmailSender } from "./modules/email";
import { invoiceRoutes } from "./modules/invoice";
import { fleetRoutes } from "./modules/fleet-map/fleet.routes";
import { cloudflareR2Routes } from "./modules/cloudflare/r2";
import { startResourceEvents } from "./ws/resource-events";

export function createApp(
  options: { automation?: boolean; externalIntegrations?: boolean; proofs?: ProofService; sms?: SmsGateway; emailSender?: EmailSender } = {},
) {
  let events: Awaited<ReturnType<typeof startResourceEvents>> | undefined;
  // Share the validated identity with the resolver without verifying a missing
  // cookie again or consuming a WebSocket ticket a second time.
  const authenticatedClaims = new WeakMap<Request, Record<string, any>>();
  let driverEvents: Awaited<ReturnType<typeof startDriverEvents>> | undefined;
  let deliveryNotifications: ReturnType<typeof startDeliveryNotificationWorker> | undefined;
  return (
    new Elysia()
      .onStart(async (app) => {
        requestManager.init();
        events = await startResourceEvents((event) =>
          app.server?.publish(TOPIC.GLOBAL, event),
        );

        driverEvents = await startDriverEvents(process.env.DATABASE_URL as string);
        if (options.externalIntegrations !== false) deliveryNotifications = startDeliveryNotificationWorker(options.sms, options.emailSender);
        if (options.automation !== false) await startAutomationTasks();
		
		console.log(`${process.env.NODE_ENV}: ${process.env.FRONTEND_URL}`);
      })
      .onStop(async () => {
        await deliveryNotifications?.stop();
        await driverEvents?.stop();
        await events?.stop();
      })
      .onRequest(({ request, set }) =>
        logger.info(`[${request.method}] ${new URL(request.url).pathname}`),
      )
      .onError(({ error, set, code }) => {
        if (error instanceof WorkflowError) {
          set.status = error.status;
          return { message: error.message };
        }
        if (code === "VALIDATION") {
          set.status = 400;

          const errors: Record<string, string> = {};

          for (const issue of error.all) {
            const field = issue.path.replace(/^\//, "");

            if (!(field in errors)) {
              errors[field] = issue.message;
            }
          }

          return {
            errors,
          };
        } else if (code === "NOT_FOUND") {
          // REDIRECT TO 404 PAGE
          set.status = 404;
          return {
            message: "Not found",
          };
        }

        if (error instanceof Error) {
          logger.error(`Request failed [${code}]: ${error.message}`);
        }

        set.status = 500;
        return {
          message: "Internal server error",
        };
      })
      .use(
        cors({
          origin: (request) =>
            allowedOrigin(request.headers.get("origin"), request.url),
          methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
          allowedHeaders: ["Content-Type", "Authorization"],
          credentials: true,
        }),
      )
      .use(authPlugin)
      .onBeforeHandle(({ request, set }) => {
        if (
          (!["GET", "HEAD", "OPTIONS"].includes(request.method) ||
            new URL(request.url).pathname === "/ws") &&
          !allowedOrigin(request.headers.get("origin"), request.url)
        ) {
          set.status = 403;
          return { message: "Request origin is not permitted." };
        }
      })
      .use(authRoutes)
      .onBeforeHandle(({ request, set }) => {
        if (
          options.externalIntegrations === false &&
          /^\/(email|sms|lalamove|geocode|geocoding|delivery-estimates|cloudflare|automations)(\/|$)/.test(
            new URL(request.url).pathname,
          )
        ) {
          set.status = 503;
          return {
            message: "External integrations are disabled in this environment.",
          };
        }
      })
       .onAfterResponse(({ request, set }) => {
         console.log(
           `[${request.method}] ${new URL(request.url).pathname}`,
           `→ ${set.status}`,
         );
       })
      .guard(
        {
          beforeHandle: async ({
            request,
            cookie: { access_token },
            jwt,
            set,
          }) => {
            const url = new URL(request.url);
            const ticket = url.pathname === "/ws" ? url.searchParams.get("ticket") : null;
            // Cookie upgrades remain supported for native/mobile clients.
            const claims = ticket !== null
              ? await consumeWsTicket(ticket)
              : typeof access_token.value === "string"
                ? await jwt.verify(access_token.value)
                : false;
            const status = await authorizeClaims(
              claims,
              UserService.getMutationActor,
              request.method,
              new URL(request.url).pathname,
            );
            if (status !== 200) {
              set.status = status;
              console.log("Unauthorized");
              return {
                message:
                  status === 401
                    ? "Unauthorized"
                    : "You do not have permission to perform this action.",
              };
            }
            if (claims) authenticatedClaims.set(request, claims);
          },
        },
        (app) =>
          app
            .resolve(
              async ({ server, request }) => {
                const payload = authenticatedClaims.get(request);
                authenticatedClaims.delete(request);

                if (!payload) {
				  console.log("Unauthorized");
                  throw new Error("Unauthorized");
                }

                const socket_address = server?.requestIP(request);

                return {
                  ip_address: socket_address?.address || "unknown",
                  current_page: "unknown",
                  user: payload,
                };
              },
            )
            .onAfterResponse(
              async ({ request, user, ip_address, body, set, server }) => {
                const method = request.method.toUpperCase();
                const url = new URL(request.url);
                const path = url.pathname;
                const status = Number(set.status);

                if (
                  !["POST", "PUT", "PATCH", "DELETE"].includes(method) ||
                  !Number.isFinite(status) ||
                  status < 200 ||
                  status >= 300 ||
                  path.startsWith("/audit-logs")
                ) {
                  return;
                }

                const segments = path.split("/").filter(Boolean);
                const resource = segments[0];
                if (resource) await events?.changed(resource === "driver" ? "deliveries" : resource);
                const { entityType, entityId } = auditTarget(path);

                await AuditLogService.createHttpAuditLog({
                  userId: Number(user.sub || -1),
                  action: `${method} ${path}`,
                  entityType,
                  entityId,
                  description: `${method} ${path} completed successfully`,
                  payload: body,
                  ipAddress: ip_address,
                  userAgent: request.headers.get("user-agent") ?? "unknown",
                  status: status,
                });
              },
            )
            .use(ws)
            .use(options.proofs ? createDriverRoutes(options.proofs) : driverRoutes)
            .use(dashboardRoutes)
            .use(productRoutes)
            .use(productVariantRoutes)
            .use(inventoryRoutes)
            .use(settingRoutes)
            .use(geocodeRoute)
            .use(archivesRoutes)
            .use(lalamoveRoutes)
            .use(notificationRoutes)
            .use(sessionRoutes)
            .use(auditLogRoutes)
            .use(userRoutes)
            .use(warehouseRoutes)
            .use(vehicleRoutes)
            .use(orderRoutes)
            .use(deliveryScheduleRoutes)
            .use(deliveriesRoutes)
            .use(calendarRoutes)
            .use(paymentRoutes)
            .use(automationRoutes)
            .use(createSmsRoutes(options.sms))
            .use(fleetRoutes)
            .use(deliveryEstimateRoutes) // TEMPORARY
            .use(geocodingRoutes)
            .use(reportsModule)
            .use(createEmailRoutes(options.emailSender))
            .use(invoiceRoutes)
            .use(cloudflareR2Routes),
      )
  );
}
