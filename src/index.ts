import { createApp } from "./app";
import { logger } from "./utils/logger";

const app = createApp({
  automation: true,
  externalIntegrations: true,
}).listen(Number(process.env.PORT ?? 5173));
logger.info(`Elysia is running at ${app.server?.hostname}:${app.server?.port}`);
