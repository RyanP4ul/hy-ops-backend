import { Elysia } from "elysia";
import { settingService } from "./service";
import { settingModel } from "./model";
import { AuthUser } from "../auth/schema";
import { operationalSettings } from "../auth/policy";

export const settingRoutes = new Elysia({ prefix: "/settings" })
  .decorate("user", AuthUser)
  .use(settingModel)
  .get("/", async ({ user }) => {
    const settings = await settingService.getAllSettings();
    return user.role === "admin" ? settings : Object.fromEntries(Object.entries(settings).filter(([name]) => operationalSettings.has(name)));
  })
  .get("/names", ({ query, user }) => {
    const names = String(query.names)
      .split(",")
      .map((name) => name.trim());

    return settingService.getSettingByNames(user.role === "admin" ? names : names.filter((name) => operationalSettings.has(name)));
  })
  .post("/", async ({ body }) => await settingService.updateSetting(body), {
    body: "setting.update",
  });
