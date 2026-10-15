import { Elysia } from "elysia";
import { settingService } from "./service";
import { settingModel } from "./model";

export const settingRoutes = new Elysia({ prefix: "/settings" })
  .use(settingModel)
  .get("/", async () => await settingService.getAllSettings())
  .get("/names", ({ query }) => {
    const names = String(query.names)
      .split(",")
      .map((name) => name.trim());

    return settingService.getSettingByNames(names);
  })
  .post("/", async ({ body }) => await settingService.updateSetting(body), {
    body: "setting.update",
  });
