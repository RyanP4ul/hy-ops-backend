import { Elysia, t } from "elysia";
import { logger } from "./utils/logger";
import { authRoutes } from "./modules/auth";
import { authPlugin } from "./plugins/auth";
import { productRoutes } from "./modules/products";
import cors from "@elysia/cors";
import { ws } from "./ws";
import "./ws/requests";
import { requestManager } from "./ws/requests/request-manager";
import { inventoryRoutes } from "./modules/inventory";
import { sessionRoutes } from "./modules/session";
import { settingRoutes } from "./modules/settings";
import { warehouseRoutes } from "./modules/warehouse";
import { productVariantRoutes } from "./modules/product_variant";
import { notificationRoutes } from "./modules/notifications";
import { auditLogRoutes } from "./modules/audit_logs";
import { userRoutes } from "./modules/user";
import { geocodeRoute } from "./api/geocode";
import { archivesRoutes } from "./modules/archives";
import { taskManager } from "./manager/task-manager";
import { vehicleRoutes } from "./modules/vehicles";
import { lalamoveRoutes } from "./modules/lalamove";
import { orderRoutes } from "./modules/order";
import { deliveryScheduleRoutes } from "./modules/delivery-schedule";
import { deliveriesRoutes } from "./modules/deliveries";
import { calendarRoutes } from "./modules/calendar";
import { paymentRoutes } from "./modules/payments";

const app = new Elysia()
  .onStart(async () => {
    requestManager.init();

    // taskManager.register("checking_product_stock", 5000, async () => {
    //   console.log("Checking product stock...");
    // });

    // taskManager.startAll();
  })
  .onRequest(({ request, set }) =>
    logger.info(`[${request.method}] ${request.url} ${set.status}`),
  )
  .onError(({ error, set, code }) => {
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
    } else if (code === "UNKNOWN") {
      return error;
    } else if (code === "NOT_FOUND") {
      // REDIRECT TO 404 PAGE
      set.status = 404;
      return {
        message: "Not found",
      };
    }

    if (error instanceof Error) {
      logger.error(`[${code}] ${error.message} - ${error.stack}`);
    }

    set.status = 500;
    return {
      message: "Internal server error",
    };
  })
  .use(
    cors({
      origin: ["http://localhost:3000"],
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      credentials: true,
    }),
  )
  .use(authPlugin)
  .use(authRoutes)

  // .onAfterResponse(({ request, set }) => {
  //   console.log(
  //     `[${request.method}] ${new URL(request.url).pathname}`,
  //     `→ ${set.status}`,
  //   );
  // })
  .guard(
    {
      beforeHandle: async ({ cookie: { access_token }, jwt, set }) => {
        if (!access_token.value) {
          set.status = 401;
          return "Unauthorized";
        }

        const payload = await jwt.verify(access_token.value as string);

        if (!payload) {
          set.status = 401;
          return "Unauthorized";
        }
      },
    },
    (app) =>
      app
        .resolve(async ({ server, request, cookie: { access_token }, jwt }) => {
          const payload = await jwt.verify(access_token.value as string);

          if (!payload) {
            throw new Error("Unauthorized");
          }

          const socket_address = server?.requestIP(request);

          return {
            ip_address: socket_address?.address || "unknown",
            current_page: "unknown",
            user: payload,
          };
        })
        .use(ws)
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
        .use(paymentRoutes),
  )
  .listen(5173);

logger.info(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
);
