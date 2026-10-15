import Elysia, { t } from "elysia";

export type LalamoveEnvelope<T> = {
  data: T;
};

export type PlaceOrderResponse = {
  orderId: string;
  quotationId: string;
  status: string;
  priceBreakdown?: {
    total?: string;
    currency?: string;
  };
  stops?: any[];
  driverId?: string;
  shareLink?: string;
};

export const lalaMoveModel = new Elysia().model({
  "lalamove.create": t.Object({
    quotation_id: t.String({ minLength: 1 }),
    sender_name: t.String({ minLength: 1 }),
    sender_phone: t.String({ minLength: 1 }),
    recipient_name: t.String({ minLength: 1 }),
    recipient_phone: t.String({ minLength: 1 }),
    pickup_address: t.String({ minLength: 1 }),
    dropoff_address: t.String({ minLength: 1 }),
  }),
});

export type LalaMoveCreateType = {
  quotation_id: string;
  sender_name: string;
  sender_phone: string;
  recipient_name: string;
  recipient_phone: string;
  pickup_address: string;
  dropoff_address: string;
};
