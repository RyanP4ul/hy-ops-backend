import { lalamoveRequest } from "@/plugins/lalamove";
import {
  LalaMoveCreateType,
  LalamoveEnvelope,
  PlaceOrderResponse,
} from "./model";
import { db } from "@/db/index";
import { delivery_orders, DeliveryOrderInsert } from "@/db/schema/lalamove";

export abstract class LalamoveService {
  static async getQuotation(quotation_id: string) {
    const quotation = await lalamoveRequest<
      LalamoveEnvelope<{
        quotationId: string;
        stops: { stopId: string }[];
        priceBreakdown?: {
          total?: string;
          currency?: string;
        };
      }>
    >("GET", `/quotations/${encodeURIComponent(quotation_id)}`);

    return quotation.data;
  }

  static async createProduct(user_id: number, data: LalaMoveCreateType) {
    // const errors: Record<string, string> = {};

    // if (Object.keys(errors).length > 0) {
    //   return {
    //     errors,
    //   };
    // }
    return await db.transaction(async (tx) => {
      const quotation = await lalamoveRequest<
        LalamoveEnvelope<PlaceOrderResponse>
      >("POST", "/quotations", data);

      if (!quotation || !quotation.data) {
        return {
          message: "Failed to create quotation",
        };
      }

      const stops = quotation.data.stops || [];

      if (stops && stops.length < 2) {
        return {
          message: "Quotation must have pickup and drop-off stops",
        };
      }

      const placed = await lalamoveRequest<
        LalamoveEnvelope<PlaceOrderResponse>
      >("POST", "/v3/orders", {
        quotationId: data.quotation_id,
        sender: {
          stopId: stops[0].stopId,
          name: data.sender_name,
          phone: data.sender_phone,
        },
        recipients: [
          {
            stopId: stops[1].stopId,
            name: data.recipient_name,
            phone: data.recipient_phone,
          },
        ],
        isPODEnabled: true,
        metadata: {
          source: "HYOps",
        },
      });

      if (!placed || !placed.data) {
        return {
          message: "Failed to place order",
        };
      }

      const [new_order] = await tx
        .insert(delivery_orders)
        .values({
          lalamove_order_id: placed.data.orderId,
          quotation_id: data.quotation_id,
          booked_by: "HyOps",
          recipient_name: data.recipient_name,
          recipient_phone: data.recipient_phone,
          pickup_address: data.pickup_address,
          dropoff_address: data.dropoff_address,
          delivery_fee: placed.data.priceBreakdown?.total ?? null,
          currency: placed.data.priceBreakdown?.currency ?? null,
          status: placed.data.status ?? "PENDING",
          lalamove_response: placed.data,
          created_at: Math.floor(Date.now() / 1000),
          updated_at: Math.floor(Date.now() / 1000),
        })
        .returning();

      if (!new_order) {
        return {
          message: "Failed to create order",
        };
      }

      return {
        message: `Order ${new_order.lalamove_order_id} created successfully`,
      };
    });
  }
}
