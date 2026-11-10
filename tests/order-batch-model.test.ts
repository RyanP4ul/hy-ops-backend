import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import { orderModel } from "../src/modules/order/model";
import { mayAccess } from "../src/modules/auth/policy";

const app = new Elysia()
  .use(orderModel)
  .post("/orders/batch", ({ body }) => body, { body: "order.batch" })
  .post("/orders/walk-in", ({ body }) => body, { body: "order.walk_in" });
const order = { warehouse_id: 1, payment_method: "CASH", payment_arrangement: "NET_30", amount_paid: 0, is_custom_shipping: false, customer_address_id: 1, items: [{ inventory_id: 1, quantity: 1 }] };
const submit = (body: object) => app.handle(new Request("http://localhost/orders/batch", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}));
const submitWalkIn = (body: object) => app.handle(new Request("http://localhost/orders/walk-in", {
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

test("walk-in order model accepts counter sales with optional customer and rejects invalid items or payment", async () => {
  const validAnon = { warehouse_id: 1, walk_in_name: "Walk-in Buyer", payment_method: "CASH", amount_tendered: 100, items: [{ inventory_id: 1, quantity: 2 }] };
  const res = await submitWalkIn(validAnon);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ warehouse_id: 1, walk_in_name: "Walk-in Buyer", payment_method: "CASH", amount_tendered: 100 });

  for (const invalid of [
    { ...validAnon, warehouse_id: 0 },
    { ...validAnon, items: [] },
    { ...validAnon, items: [{ inventory_id: 1, quantity: 0 }] },
    { ...validAnon, amount_tendered: -5 },
    { ...validAnon, payment_method: "INVALID" },
  ]) {
    expect((await submitWalkIn(invalid)).status).toBe(422);
  }

  expect(mayAccess("admin", "POST", "/orders/walk-in")).toBe(true);
  expect(mayAccess("staff", "POST", "/orders/walk-in")).toBe(true);
  expect(mayAccess("driver", "POST", "/orders/walk-in")).toBe(false);
  expect(mayAccess("customer", "POST", "/orders/walk-in")).toBe(false);
});
