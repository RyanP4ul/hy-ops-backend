import { Elysia } from "elysia";
import { getOptions } from "../services/options.service";

export const optionsRoutes = new Elysia({ name: "reports.options" }).get("/options", () => getOptions(), {
  detail: { tags: ["Reports"], summary: "Choices for the filter dropdowns" },
});
