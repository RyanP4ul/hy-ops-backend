import { createApp } from "./app";
import { logger } from "./utils/logger";

const app = createApp({
  automation: process.env.HYOPS_ENABLE_AUTOMATION !== "false",
  externalIntegrations: process.env.HYOPS_ENABLE_INTEGRATIONS !== "false",
}).listen(Number(process.env.PORT ?? 5173));
logger.info(`Elysia is running at ${app.server?.hostname}:${app.server?.port}`);
