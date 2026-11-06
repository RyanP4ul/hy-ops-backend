import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import { orderModel } from "../src/modules/order/model";
import { mayAccess } from "../src/modules/auth/policy";

const app = new Elysia().use(orderModel).post("/orders/batch", ({ body }) => body, { body: "order.batch" });
const order = { warehouse_id: 1, payment_method: "CASH", payment_arrangement: "NET_30", amount_paid: 0, is_custom_shipping: false, customer_address_id: 1, items: [{ inventory_id: 1, quantity: 1 }] };
const submit = (body: object) => app.handle(new Request("http://localhost/orders/batch", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}));

test("group submission selects one customer with separate saved destinations, items and payments", async () => {
  const response = await submit({ customer_id: 7, orders: [order, { ...order, customer_address_id: 2, amount_paid: 5, items: [{ inventory_id: 3, quantity: 2 }] }] });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ customer_id: 7, orders: [
    { customer_address_id: 1, amount_paid: 0 }, { customer_address_id: 2, amount_paid: 5, items: [{ inventory_id: 3, quantity: 2 }] },
  ] });
});

test("group API rejects empty or oversized submissions, invalid customers and invalid order entries", async () => {
  for (const body of [
    { customer_id: 1, orders: [] }, { customer_id: 1, orders: Array.from({ length: 26 }, () => order) },
    { customer_id: 0, orders: [order] }, { orders: [order] },
    { customer_id: 1, orders: [{ ...order, items: [] }] },
    { customer_id: 1, orders: [{ ...order, items: [{ inventory_id: 1, quantity: 0 }] }] },
    { customer_id: 1, orders: [{ ...order, customer_address_id: -1 }] },
  ]) expect((await submit(body)).status).toBe(422);
  expect(mayAccess("staff", "POST", "/orders/batch")).toBe(true);
  expect(mayAccess("driver", "POST", "/orders/batch")).toBe(false);
  expect(mayAccess("customer", "POST", "/orders/batch")).toBe(false);
});

test("combined payment API accepts one payment and rejects invalid or missing shared details", async () => {
  const combined = { customer_id: 7, payment_mode: "COMBINED", payment: { payment_method: "CASH", amount_paid: 5 }, orders: [order, order] };
  expect((await submit(combined)).status).toBe(200);
  for (const body of [{ ...combined, payment: undefined }, { ...combined, payment: { payment_method: "CASH", amount_paid: 0 } }, { ...combined, payment_mode: "OTHER" }, { ...combined, payment: { payment_method: "OTHER", amount_paid: 5 } }]) {
    expect((await submit(body)).status).toBe(422);
  }
});
