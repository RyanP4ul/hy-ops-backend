# Order submission groups

Apply `bun run db:migrate` from the backend before running the updated server.
Migration `0006_order_groups` adds permanent submission groups and nullable group
membership/position columns to orders. Existing orders remain ungrouped: neither
customer identity nor matching timestamps prove that orders were submitted together.

Each successful `POST /orders/batch` creates one group in the same transaction as
its orders, stock reservations, invoices and payments. This applies to separate and
combined payment. Payment groups remain separate receipt records. A failed member
rolls the complete submission back, including its group.

Order list, order detail, ready-order selectors and delivery stop responses expose
group references. Group membership and original positions remain unchanged when
orders are scheduled, cancelled or completed. Search accepts the group reference.

`GET /delivery-schedules` paginates scheduling entries, counting a group once.
A group appears as soon as any scoped member reaches Scheduling; its expanded
members include waiting orders. Each entry reports its ready count, total members,
readiness and blocking reason. Search matches the group reference or any scoped
member order/address. Staff receive only their warehouse's member details; a group
spanning warehouses cannot be scheduled as a single run.

`GET /orders/groups/:groupId/ready?warehouse_id=...` returns the complete group in
its original order only when every member belongs to the warehouse and has
Scheduling status. Otherwise it returns 409; groups absent in scope return 404.

Selecting a group adds all its orders; removing a selected group removes all its
members. Orders keep their own saved destination, invoice, payment and delivery
stop. Staff can reorder the individual stops without changing group membership.

Delivery creation locks every member of the selected groups in ID order. It
rejects groups with unready members and requests omitting any member, and marks
all selected orders Scheduled in one transaction. This rule applies to direct API
requests as well as the scheduling dialog. Older partially scheduled groups do
not bypass the rule. Groups must fit the selected date's available slots; they
cannot be split to bypass capacity or readiness checks.
