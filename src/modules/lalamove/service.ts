import { lalamoveRequest } from "@/plugins/lalamove";
import { db } from "@/db/index";
import { delivery_orders } from "@/db/schema/lalamove";
import type {
  LalaMoveCreateType,
  LalamoveEnvelope,
  LalamoveQuotationCreateType,
  LalamoveQuotationResponse,
  PlaceOrderResponse,
} from "./model";
import { logger } from "../../utils/logger";

export abstract class LalamoveService {
  static async createQuotation(data: LalamoveQuotationCreateType) {
    const response = await lalamoveRequest<
      LalamoveEnvelope<LalamoveQuotationResponse>
    >("POST", "/quotations", {
      data: {
        serviceType: data.service_type,
        language: "en_PH",
        stops: [
          {
            coordinates: {
              lat: String(data.pickup_latitude),
              lng: String(data.pickup_longitude),
            },
            address: data.pickup_address,
          },
          {
            coordinates: {
              lat: String(data.dropoff_latitude),
              lng: String(data.dropoff_longitude),
            },
            address: data.dropoff_address,
          },
        ],
      },
    });

    return response.data;
  }

  static async getQuotation(quotationId: string) {
    const response = await lalamoveRequest<
      LalamoveEnvelope<LalamoveQuotationResponse>
    >("GET", `/quotations/${encodeURIComponent(quotationId)}`);

    return response.data;
  }

  static async placeOrder(data: LalaMoveCreateType) {
    // Retrieve Lalamove's canonical quotation data so the stop IDs always match.
    const quotation = await this.getQuotation(data.quotation_id);

    if (quotation.expiresAt) {
      const expiration = Date.parse(quotation.expiresAt);
      if (Number.isFinite(expiration) && expiration <= Date.now()) {
        throw new Error(
          "This Lalamove quotation has expired. Create a new quotation.",
        );
      }
    }

    const pickupStop = quotation.stops?.[0];
    const dropoffStop = quotation.stops?.[1];

    if (!pickupStop?.stopId || !dropoffStop?.stopId) {
      throw new Error(
        "Quotation must have a pickup and a drop-off stop with stop IDs.",
      );
    }

    // lalamoveRequest() already adds /v3, so this path must be /orders.
    const response = await lalamoveRequest<
      LalamoveEnvelope<PlaceOrderResponse>
    >("POST", "/orders", {
      data: {
        quotationId: quotation.quotationId,
        sender: {
          stopId: pickupStop.stopId,
          name: data.sender_name,
          phone: data.sender_phone,
        },
        recipients: [
          {
            stopId: dropoffStop.stopId,
            name: data.recipient_name,
            phone: data.recipient_phone,
          },
        ],
        isPODEnabled: true,
        metadata: {
          source: "HYOps",
        },
      },
    });

    const placed = response.data;
    if (!placed?.orderId) {
      throw new Error("Lalamove did not return an order ID.");
    }

    // The external booking cannot be rolled back if this DB write fails.
    // Production should record booking attempts and reconcile this case.
    let newOrder = {
      lalamove_order_id: placed.orderId,
      quotation_id: quotation.quotationId,
      booked_by: "HYOps",
      recipient_name: data.recipient_name,
      recipient_phone: data.recipient_phone,
      pickup_address: data.pickup_address,
      dropoff_address: data.dropoff_address,
      delivery_fee: placed.priceBreakdown?.total ?? null,
      currency: placed.priceBreakdown?.currency ?? null,
      status: placed.status ?? "PENDING",
      lalamove_response: placed,
      created_at: Math.floor(Date.now() / 1000),
      updated_at: Math.floor(Date.now() / 1000),
    };

    logger.debug(
      "Lalamove order placed successfully: ",
      JSON.stringify(newOrder),
    );

    // try {
    //   const result = await db
    //     .insert(delivery_orders)
    //     .values({
    //       lalamove_order_id: placed.orderId,
    //       quotation_id: quotation.quotationId,
    //       booked_by: "HYOps",
    //       recipient_name: data.recipient_name,
    //       recipient_phone: data.recipient_phone,
    //       pickup_address: data.pickup_address,
    //       dropoff_address: data.dropoff_address,
    //       delivery_fee: placed.priceBreakdown?.total ?? null,
    //       currency: placed.priceBreakdown?.currency ?? null,
    //       status: placed.status ?? "PENDING",
    //       lalamove_response: placed,
    //       created_at: Math.floor(Date.now() / 1000),
    //       updated_at: Math.floor(Date.now() / 1000),
    //     })
    //     .returning();

    //   newOrder = result[0];
    // } catch (error) {
    //   console.error(
    //     "Lalamove order was created but could not be saved in HYOps",
    //     {
    //       lalamoveOrderId: placed.orderId,
    //       error,
    //     },
    //   );
    //   throw new Error(
    //     `Lalamove order ${placed.orderId} was created, but saving it to HYOps failed. Reconcile this order before retrying.`,
    //   );
    // }

    // if (!newOrder) {
    //   throw new Error(
    //     `Lalamove order ${placed.orderId} was created, but no HYOps database row was returned.`,
    //   );
    // }

    return {
      message: "Lalamove order created successfully",
      data: {
        id: newOrder.lalamove_order_id,
        orderId: placed.orderId,
        quotationId: quotation.quotationId,
        status: newOrder.status,
        deliveryFee: newOrder.delivery_fee,
        currency: newOrder.currency,
        shareLink: placed.shareLink,
      },
    };
  }
}
