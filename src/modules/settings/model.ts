import Elysia, { t } from "elysia";

const SettingSchema = t.Object({
  name: t.String({ minLength: 1, maxLength: 60 }),
  value: t.String({ minLength: 1, maxLength: 60 }),
  version: t.Number({ minimum: 1 }),
});

export const settingModel = new Elysia().model({
  "setting.update": t.Array(SettingSchema),
});
