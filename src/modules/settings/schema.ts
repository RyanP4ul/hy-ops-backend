import z from "zod";

export const settingSchema = z.object({
  id: z.number(),
  name: z.string().min(1).max(60),
  value: z.string().min(1).max(60),
  version: z.number().min(1),
});

export type SettingSchemaType = z.infer<typeof settingSchema>;
