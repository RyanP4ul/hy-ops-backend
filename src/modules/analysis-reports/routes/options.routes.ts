import { Elysia } from "elysia";
import { getOptions } from "../services/options.service";

export const optionsRoutes = new Elysia({ name: "reports.options" }).get("/options", () => getOptions(), {
  detail: {
    tags: ["Reports"],
    summary: "Get report filter options",
    description: "Retrieve the available choices for report filter dropdowns.",
  },
});
