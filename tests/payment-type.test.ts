import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import { orderModel } from "../src/modules/order/model";

const app = new Elysia().use(orderModel).post("/orders", ({ body }) => body, { body: "order.create" });
const draft = { warehouse_id: 1, customer_id: 1, payment_method: "BANK_TRANSFER", payment_arrangement: "NET_30", amount_paid: 0, is_custom_shipping: false, customer_address_id: 1, items: [{ inventory_id: 1, quantity: 1 }] };
const submit = (data: object) => app.handle(new Request("http://localhost/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) }));

test("order API accepts standard and custom payment types without changing their case", async () => {
  for (const [payment_method, payment_type] of [["BANK_TRANSFER", "BDO"], ["CARD", "Visa"], ["BANK_TRANSFER", "Custom cooperative"]]) {
    const response = await submit({ ...draft, payment_method, payment_type });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ payment_method, payment_type });
  }
});

test("order API rejects blank and overlong payment types and accepts legacy requests", async () => {
  for (const payment_type of ["", "   ", "x".repeat(101)]) expect((await submit({ ...draft, payment_type })).status).toBe(422);
  expect((await submit(draft)).status).toBe(200);
});
