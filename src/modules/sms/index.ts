import { Elysia } from "elysia";
import { smsModel } from "./modal";
import { SmsGateway } from "./service";

export function createSmsRoutes(gateway = new SmsGateway()) {
  return new Elysia({ prefix: "/sms" }).use(smsModel)
    .get("/stats", () => gateway.stats(), { detail: { summary: 'Get stats', description: 'GET endpoint for stats in the sms module.', tags: ['SMS'] } })
    .get("/templates", () => gateway.templates(), { detail: { summary: 'Get templates', description: 'GET endpoint for templates in the sms module.', tags: ['SMS'] } })
    .post("/send-sms", ({ body }) => gateway.send(body), {
      detail: { summary: 'Create send sms', description: 'POST endpoint for send sms in the sms module.', tags: ['SMS'] }, body: "sms.send" });
}
export const smsRoutes = createSmsRoutes();
