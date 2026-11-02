import { Elysia } from "elysia";
import { smsModel } from "./modal";
import { SmsGateway } from "./service";

export function createSmsRoutes(gateway = new SmsGateway()) {
  return new Elysia({ prefix: "/sms" }).use(smsModel)
    .get("/stats", () => gateway.stats())
    .get("/templates", () => gateway.templates())
    .post("/send-sms", ({ body }) => gateway.send(body), { body: "sms.send" });
}
export const smsRoutes = createSmsRoutes();
