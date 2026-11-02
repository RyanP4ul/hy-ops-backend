import Elysia, { t } from "elysia";

export type LalamoveEnvelope<T> = {
  data: T;
};

export type LalamoveStop = {
  stopId: string;
  address?: string;
  coordinates?: {
    lat: string;
    lng: string;
  };
};

export type LalamovePriceBreakdown = {
  total?: string;
  currency?: string;
  [key: string]: string | undefined;
};

export type LalamoveQuotationResponse = {
  quotationId: string;
  stops: LalamoveStop[];
  expiresAt?: string;
  serviceType?: string;
  priceBreakdown?: LalamovePriceBreakdown;
};

export type PlaceOrderResponse = {
  orderId: string;
  quotationId: string;
  status: string;
  priceBreakdown?: LalamovePriceBreakdown;
  stops?: LalamoveStop[];
  driverId?: string;
  shareLink?: string;
  metadata?: Record<string, string>;
};

export type LalamoveQuotationCreateType = {
  service_type: string;
  pickup_address: string;
  pickup_latitude: number;
  pickup_longitude: number;
  dropoff_address: string;
  dropoff_latitude: number;
  dropoff_longitude: number;
};

export type LalaMoveCreateType = {
  quotation_id: string;
  sender_name: string;
  sender_phone: string;
  recipient_name: string;
  recipient_phone: string;
  pickup_address: string;
  dropoff_address: string;
};

export const lalaMoveModel = new Elysia().model({
  "lalamove.create": t.Object({
    quotation_id: t.String({ minLength: 1 }),
    sender_name: t.String({ minLength: 1 }),
    sender_phone: t.String({ minLength: 7, maxLength: 20 }),
    recipient_name: t.String({ minLength: 1 }),
    recipient_phone: t.String({ minLength: 7, maxLength: 20 }),
    pickup_address: t.String({ minLength: 1 }),
    dropoff_address: t.String({ minLength: 1 }),
  }),
  "lalamove.quotation": t.Object({
    service_type: t.String({ minLength: 1 }),
    pickup_address: t.String({ minLength: 1 }),
    pickup_latitude: t.Number({ minimum: -90, maximum: 90 }),
    pickup_longitude: t.Number({ minimum: -180, maximum: 180 }),
    dropoff_address: t.String({ minLength: 1 }),
    dropoff_latitude: t.Number({ minimum: -90, maximum: 90 }),
    dropoff_longitude: t.Number({ minimum: -180, maximum: 180 }),
  }),
});
