import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db/index";
import {
  inventory,
  product_variants,
  products,
  stock_movements,
  stock_transfer_items,
  stock_transfers,
  users,
  warehouses,
} from "@/db/schema";
import { activeInventory, activeWarehouse } from "../lifecycle/availability";
import { stockTransaction } from "./transaction";
import { WorkflowError } from "../../utils/workflow-error";
import { nowEpochSeconds } from "../../utils/time";

export abstract class StockTransferService {
  static async list(warehouseId?: number) {
    const transfers = await db
      .select({
        id: stock_transfers.id,
        transfer_number: stock_transfers.transfer_number,
        from_warehouse_id: stock_transfers.from_warehouse_id,
        to_warehouse_id: stock_transfers.to_warehouse_id,
        status: stock_transfers.status,
        notes: stock_transfers.notes,
        version: stock_transfers.version,
        dispatched_at: stock_transfers.dispatched_at,
        received_at: stock_transfers.received_at,
        created_at: stock_transfers.created_at,
        requested_by_name: users.name,
      })
      .from(stock_transfers)
      .leftJoin(users, eq(users.id, stock_transfers.requested_by))
      .where(
        warehouseId === undefined
          ? undefined
          : or(
              eq(stock_transfers.from_warehouse_id, warehouseId),
              eq(stock_transfers.to_warehouse_id, warehouseId),
            ),
      )
      .orderBy(desc(stock_transfers.id))
      .limit(100);

    if (!transfers.length) return [];

    const warehouseIds = [
      ...new Set(
        transfers.flatMap((t) => [t.from_warehouse_id, t.to_warehouse_id]),
      ),
    ];
    const transferIds = transfers.map((t) => t.id);

    const [warehouseRows, itemRows] = await Promise.all([
      db
        .select({ id: warehouses.id, name: warehouses.name })
        .from(warehouses)
        .where(inArray(warehouses.id, warehouseIds)),
      db
        .select({
          transfer_id: stock_transfer_items.transfer_id,
          product_variant_id: stock_transfer_items.product_variant_id,
          quantity_sent: stock_transfer_items.quantity_sent,
          quantity_received: stock_transfer_items.quantity_received,
          sku: product_variants.sku,
          variant_name: product_variants.name,
          product_name: products.name,
          unit: product_variants.unit,
        })
        .from(stock_transfer_items)
        .innerJoin(
          product_variants,
          eq(product_variants.id, stock_transfer_items.product_variant_id),
        )
        .innerJoin(products, eq(products.id, product_variants.product_id))
        .where(inArray(stock_transfer_items.transfer_id, transferIds))
        .orderBy(asc(stock_transfer_items.id)),
    ]);

    const warehouseMap = new Map(warehouseRows.map((w) => [w.id, w.name]));
    const itemsMap = new Map<number, typeof itemRows>();
    for (const item of itemRows) {
      const list = itemsMap.get(item.transfer_id) ?? [];
      list.push(item);
      itemsMap.set(item.transfer_id, list);
    }

    return transfers.map((t) => ({
      ...t,
      from_warehouse_name: warehouseMap.get(t.from_warehouse_id) ?? "Unknown",
      to_warehouse_name: warehouseMap.get(t.to_warehouse_id) ?? "Unknown",
      items: itemsMap.get(t.id) ?? [],
    }));
  }

  static async create(
    input: {
      from_warehouse_id: number;
      to_warehouse_id: number;
      notes?: string;
      items: Array<{ product_variant_id: number; quantity: number }>;
    },
    actorId: number,
    scopedWarehouseId?: number,
  ) {
    if (input.from_warehouse_id === input.to_warehouse_id) {
      throw new WorkflowError(
        "Source and destination warehouses must be different.",
        400,
      );
    }
    if (
      scopedWarehouseId !== undefined &&
      input.from_warehouse_id !== scopedWarehouseId
    ) {
      throw new WorkflowError(
        "Staff can only initiate stock transfers from their assigned warehouse.",
        403,
      );
    }
    if (!input.items.length) {
      throw new WorkflowError("Select at least one variant to transfer.", 400);
    }

    return stockTransaction(async (tx) => {
      const [fromWh, toWh] = await Promise.all([
        tx
          .select({ id: warehouses.id })
          .from(warehouses)
          .where(and(eq(warehouses.id, input.from_warehouse_id), activeWarehouse()))
          .for("share"),
        tx
          .select({ id: warehouses.id })
          .from(warehouses)
          .where(and(eq(warehouses.id, input.to_warehouse_id), activeWarehouse()))
          .for("share"),
      ]);
      if (!fromWh.length || !toWh.length) {
        throw new WorkflowError("Both warehouses must be active.", 400);
      }

      const uniqueVariants = new Set<number>();
      for (const item of input.items) {
        if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
          throw new WorkflowError("Transfer quantities must be positive integers.", 400);
        }
        if (uniqueVariants.has(item.product_variant_id)) {
          throw new WorkflowError("Duplicate product variant in transfer.", 400);
        }
        uniqueVariants.add(item.product_variant_id);
      }

      const transferNumber = `TRF-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 900 + 100)}`;
      const [created] = await tx
        .insert(stock_transfers)
        .values({
          transfer_number: transferNumber,
          from_warehouse_id: input.from_warehouse_id,
          to_warehouse_id: input.to_warehouse_id,
          status: "draft",
          notes: input.notes?.trim() || null,
          requested_by: actorId,
        })
        .returning();

      await tx.insert(stock_transfer_items).values(
        input.items.map((item) => ({
          transfer_id: created.id,
          product_variant_id: item.product_variant_id,
          quantity_sent: item.quantity,
        })),
      );

      return created;
    });
  }

  static async dispatch(
    transferId: number,
    version: number,
    actorId: number,
    scopedWarehouseId?: number,
  ) {
    return stockTransaction(async (tx) => {
      const [transfer] = await tx
        .select()
        .from(stock_transfers)
        .where(eq(stock_transfers.id, transferId))
        .for("update");
      if (!transfer) throw new WorkflowError("Stock transfer not found.", 404);
      if (
        scopedWarehouseId !== undefined &&
        transfer.from_warehouse_id !== scopedWarehouseId
      ) {
        throw new WorkflowError(
          "Only staff from the source warehouse or an admin can dispatch this transfer.",
          403,
        );
      }
      if (transfer.status !== "draft" || transfer.version !== version) {
        throw new WorkflowError(
          "Transfer changed or is not in draft status. Refresh and try again.",
          409,
        );
      }

      const items = await tx
        .select()
        .from(stock_transfer_items)
        .where(eq(stock_transfer_items.transfer_id, transfer.id))
        .orderBy(asc(stock_transfer_items.product_variant_id));

      for (const item of items) {
        const [stock] = await tx
          .select()
          .from(inventory)
          .where(
            and(
              eq(inventory.warehouse_id, transfer.from_warehouse_id),
              eq(inventory.product_variant_id, item.product_variant_id),
              activeInventory(),
            ),
          )
          .for("update");
        if (!stock || stock.quantity - stock.reserved < item.quantity_sent) {
          throw new WorkflowError(
            `Insufficient available stock in source warehouse for variant #${item.product_variant_id}.`,
            409,
          );
        }
        const nextQty = stock.quantity - item.quantity_sent;
        await tx
          .update(inventory)
          .set({
            quantity: nextQty,
            version: stock.version + 1,
            updated_at: nowEpochSeconds(),
          })
          .where(eq(inventory.id, stock.id));
        await tx.insert(stock_movements).values({
          inventory_id: stock.id,
          actor_id: actorId,
          kind: "transfer_out",
          quantity_delta: -item.quantity_sent,
          reserved_delta: 0,
          quantity_after: nextQty,
          reserved_after: stock.reserved,
          reason: `Stock transfer ${transfer.transfer_number} dispatched to warehouse #${transfer.to_warehouse_id}`,
        });
      }

      const now = new Date();
      await tx
        .update(stock_transfers)
        .set({
          status: "in_transit",
          dispatched_by: actorId,
          dispatched_at: now,
          version: transfer.version + 1,
          updated_at: now,
        })
        .where(eq(stock_transfers.id, transfer.id));

      return { ok: true as const, id: transfer.id, status: "in_transit" as const };
    });
  }

  static async receive(
    transferId: number,
    version: number,
    actorId: number,
    scopedWarehouseId?: number,
  ) {
    return stockTransaction(async (tx) => {
      const [transfer] = await tx
        .select()
        .from(stock_transfers)
        .where(eq(stock_transfers.id, transferId))
        .for("update");
      if (!transfer) throw new WorkflowError("Stock transfer not found.", 404);
      if (
        scopedWarehouseId !== undefined &&
        transfer.to_warehouse_id !== scopedWarehouseId
      ) {
        throw new WorkflowError(
          "Only staff at the destination warehouse or an admin can receive this transfer.",
          403,
        );
      }
      if (transfer.status !== "in_transit" || transfer.version !== version) {
        throw new WorkflowError(
          "Transfer changed or is not in transit. Refresh and try again.",
          409,
        );
      }

      const items = await tx
        .select({
          id: stock_transfer_items.id,
          product_variant_id: stock_transfer_items.product_variant_id,
          quantity_sent: stock_transfer_items.quantity_sent,
          product_id: product_variants.product_id,
        })
        .from(stock_transfer_items)
        .innerJoin(
          product_variants,
          eq(product_variants.id, stock_transfer_items.product_variant_id),
        )
        .where(eq(stock_transfer_items.transfer_id, transfer.id))
        .orderBy(asc(stock_transfer_items.product_variant_id));

      for (const item of items) {
        const [existing] = await tx
          .select()
          .from(inventory)
          .where(
            and(
              eq(inventory.warehouse_id, transfer.to_warehouse_id),
              eq(inventory.product_variant_id, item.product_variant_id),
            ),
          )
          .for("update");

        let targetInventoryId: number;
        let nextQty: number;
        let reservedAfter = 0;

        if (existing) {
          targetInventoryId = existing.id;
          nextQty = existing.quantity + item.quantity_sent;
          reservedAfter = existing.reserved;
          await tx
            .update(inventory)
            .set({
              quantity: nextQty,
              is_archived: false,
              is_active: true,
              version: existing.version + 1,
              updated_at: nowEpochSeconds(),
            })
            .where(eq(inventory.id, existing.id));
        } else {
          const nowSec = nowEpochSeconds();
          const [inserted] = await tx
            .insert(inventory)
            .values({
              warehouse_id: transfer.to_warehouse_id,
              product_id: item.product_id,
              product_variant_id: item.product_variant_id,
              quantity: item.quantity_sent,
              reserved: 0,
              created_at: nowSec,
              updated_at: nowSec,
            })
            .returning();
          targetInventoryId = inserted.id;
          nextQty = item.quantity_sent;
        }

        await tx.insert(stock_movements).values({
          inventory_id: targetInventoryId,
          actor_id: actorId,
          kind: "transfer_in",
          quantity_delta: item.quantity_sent,
          reserved_delta: 0,
          quantity_after: nextQty,
          reserved_after: reservedAfter,
          reason: `Stock transfer ${transfer.transfer_number} received from warehouse #${transfer.from_warehouse_id}`,
        });

        await tx
          .update(stock_transfer_items)
          .set({ quantity_received: item.quantity_sent })
          .where(eq(stock_transfer_items.id, item.id));
      }

      const now = new Date();
      await tx
        .update(stock_transfers)
        .set({
          status: "received",
          received_by: actorId,
          received_at: now,
          version: transfer.version + 1,
          updated_at: now,
        })
        .where(eq(stock_transfers.id, transfer.id));

      return { ok: true as const, id: transfer.id, status: "received" as const };
    });
  }

  static async cancel(
    transferId: number,
    version: number,
    scopedWarehouseId?: number,
  ) {
    return stockTransaction(async (tx) => {
      const [transfer] = await tx
        .select()
        .from(stock_transfers)
        .where(eq(stock_transfers.id, transferId))
        .for("update");
      if (!transfer) throw new WorkflowError("Stock transfer not found.", 404);
      if (
        scopedWarehouseId !== undefined &&
        transfer.from_warehouse_id !== scopedWarehouseId
      ) {
        throw new WorkflowError("Not authorized to cancel this transfer.", 403);
      }
      if (transfer.status !== "draft" || transfer.version !== version) {
        throw new WorkflowError("Only draft transfers can be cancelled.", 409);
      }
      await tx
        .update(stock_transfers)
        .set({
          status: "cancelled",
          version: transfer.version + 1,
          updated_at: new Date(),
        })
        .where(eq(stock_transfers.id, transfer.id));
      return { ok: true as const, id: transfer.id, status: "cancelled" as const };
    });
  }
}
