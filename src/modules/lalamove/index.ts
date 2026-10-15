import { lalamoveRequest } from "@/plugins/lalamove";
import Elysia from "elysia";

export const lalamoveRoutes = new Elysia({
  prefix: "/lalamove",
}).get("/cities", async ({ set }) => {
  try {
    return await lalamoveRequest("GET", "/cities");
  } catch (error) {
    set.status = 502;

    return {
      message: "Unable to connect to Lalamove sandbox",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
});
