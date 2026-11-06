# Multiple active orders per customer

## Payment choices

For two or more orders, the Payment step offers **Separate payments per order**
(the default) and **One payment for all orders**. Single orders use their own
payment fields. Removing drafts until one order remains returns to separate
mode. Switching modes preserves the separate draft entries. Combined
mode uses one method, provider, amount received, and optional bank/card reference.
The browser previews every allocation before submission. Use full total fills
the combined order value; a partial receipt is allocated proportionally using
exact centavos and deterministic largest-remainder rounding.

The server rechecks prices and inventory. Each order receives only its allocated
amount and is marked fully paid, partially paid, or Net 30 when its allocation is
zero. Select separate mode when individual orders require different terms.
Reviewed-price mismatches reject the submission so allocations cannot silently
change after review.

One immutable `payment_groups` record identifies the original combined receipt.
`payment_group_allocations` preserves its initial split across per-order payment
records. Existing receipt/refund ledgers and financial reports sum the per-order
amounts; the parent receipt is never added again. Later receipts, cancellations
and refunds affect the selected order and retain the original allocation for
reconciliation. Refund actions continue to apply per order.

Payments can be searched by the CP receipt number or shared payment reference.
Order details, invoices and their PDF exports display the original combined
reference and allocation. Drivers see the shared reference and allocation for
their own assigned stop, without the other orders' financial details.

Apply `src/db/migrations/0005_payment_groups.sql` through `bun run db:migrate`
before deploying this version. Existing orders remain separate payments and need
no backfill. The disposable database script verifies the upgrade migration.

The combined API payload is `{ customer_id, payment_mode: "COMBINED", payment:
{ payment_method, payment_type?, amount_paid, reference_number? }, orders: [...] }`.
Combined order entries omit their payment fields and may include `expected_total`
to reject stale prices. The browser always includes reviewed totals. Requests
without `payment_mode`, or with `payment_mode: "SEPARATE"`, retain the separate
payment API contract.

## Create several orders together

In Orders, select Add Order and choose the customer once. Prepare the first
order's saved shipping address, items and payment, then select Add another order
from the review step. Repeat for each destination. The customer remains the same;
each draft has independent items, payment details and a saved shipping address.
The draft list lets operators return to edit or remove an order without losing
the others. Select Create all orders to submit the group. One order can still be
created on its own. Up to 25 orders can be submitted together.

`POST /orders/batch` accepts `{ customer_id, orders: [...] }`. Each entry uses the
single-order fields except `customer_id`, which is supplied once at the top level.
It returns `{ orders: [...], message }`, containing the created order rows.
The entire group is created in one stock transaction. An invalid entry rolls back
all orders, reservations, payments and invoices. Quantities sharing inventory are
checked together; concurrent submissions cannot oversell stock. A failure message
identifies the order that needs attention. Staff can only submit orders from their
assigned warehouse. Driver accounts cannot create orders.

The browser preserves all drafts when submission fails. The driver app receives
one independent stop for each created order through the existing delivery APIs.

## Order independence

A customer may have one or several active orders. Orders remain independent:
each has its own order number, saved shipping destination, items, reserved stock,
payment records, invoice, delivery stop, and outcome. Completing or cancelling one
order does not complete or cancel the customer's other orders.

New orders must include `is_custom_shipping: false` and a `customer_address_id`
owned by the selected customer. Checkout copies the saved address and coordinates
into the order. Later changes to the customer's address book do not redirect
existing orders or change their invoices. Supplied manual address fields cannot
override the selected saved address.

The web order form can save another address before checkout using
`POST /orders/customers/:customerId/addresses`. It accepts `address_line`,
`barangay`, `city_municipality`, `province`, optional `postal_code`, and numeric
`latitude` and `longitude`. Coordinates must be valid and cannot both be zero.
The new address belongs to the customer and is available for later orders.
Administrators and operational staff can save addresses; driver access remains
restricted to assigned deliveries.

The former `customer_order_limit` setting is no longer enforced or displayed.
Removing the former order limit requires no reseeding. The compatibility
endpoint `GET /orders/eligibility/:customerId` still reports the active count,
with `eligible: true` and `maxActiveOrders: null`. Daily and vehicle capacity
checks still apply during delivery scheduling.

The mobile driver app displays each order number alongside its own destination,
including navigation, delivery confirmation, and delivery history. Multiple
orders for the same customer are separate stops and retain separate payments.
