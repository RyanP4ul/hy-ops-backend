import { lalamoveRequest } from "@/plugins/lalamove";
import Elysia from "elysia";
import { LalamoveService } from "./service";
import { lalaMoveModel } from "./model";

export const lalamoveRoutes = new Elysia({
  prefix: "/lalamove",
})
  .use(lalaMoveModel)
  .get("/cities", async ({ set }) => {
    try {
      return await lalamoveRequest("GET", "/cities");
    } catch (error) {
      set.status = 502;

      return {
        message: "Unable to connect to Lalamove sandbox",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }, { detail: { summary: 'Get cities', description: 'GET endpoint for cities in the lalamove module.', tags: ['Lalamove'] } })
  .post(
    "/quotations",
    async ({ body, set }) => {
      try {
        return { data: await LalamoveService.createQuotation(body) };
      } catch (error) {
        set.status = 502;
        return {
          message: "Unable to create Lalamove quotation",
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
    {
      detail: { summary: 'Create quotations', description: 'POST endpoint for quotations in the lalamove module.', tags: ['Lalamove'] }, body: "lalamove.quotation" },
  )
  .post(
    "/orders",
    async ({ body, set }) => {
      try {
        return await LalamoveService.placeOrder(body);
      } catch (error) {
        set.status = 502;
        return {
          message: "Unable to place Lalamove order",
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
    {
      detail: { summary: 'Create orders', description: 'POST endpoint for orders in the lalamove module.', tags: ['Lalamove'] }, body: "lalamove.create" },
  );
