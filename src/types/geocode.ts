export type GeocodingResult = {
  id: string;
  label: string;
  addressLine: string;
  houseNumber: string | null;
  street: string | null;
  district: string | null;
  city: string | null;
  province: string | null;
  country: string | null;
  latitude: number;
  longitude: number;
};

export type GeocodingSearchResponse = {
  results: GeocodingResult[];
  error?: string;
};
