export type LalamoveStop = {
  stopId: string;
  POD?: { status?: string; image?: string; deliveredAt?: string };
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
