import { Elysia, t } from "elysia";

/**
 * Photon address autocomplete route for HYOps.
 * Mount this plugin in your existing Elysia app with `.use(geocodingRoutes)`.
 * GET /api/geocoding/search?q=Guiguinto&lat=14.83&lon=120.88
 */

const PHOTON_API_URL = "https://photon.komoot.io/api/";
const DEFAULT_LATITUDE = 14.83;
const DEFAULT_LONGITUDE = 120.88;
const MIN_QUERY_LENGTH = 3;
const MAX_QUERY_LENGTH = 180;
const RESULT_LIMIT = 8;

type GeocodingResult = {
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

type GeocodingSearchResponse = {
  results: GeocodingResult[];
  error?: string;
};

interface PhotonProperties {
  name?: unknown;
  housenumber?: unknown;
  street?: unknown;
  district?: unknown;
  suburb?: unknown;
  locality?: unknown;
  city?: unknown;
  town?: unknown;
  village?: unknown;
  municipality?: unknown;
  county?: unknown;
  state?: unknown;
  country?: unknown;
  countrycode?: unknown;
  osm_type?: unknown;
  osm_id?: unknown;
}

interface PhotonFeature {
  properties?: PhotonProperties;
  geometry?: { coordinates?: unknown };
}

interface PhotonFeatureCollection {
  features?: PhotonFeature[];
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const result = asText(value);
    if (result) return result;
  }
  return null;
}

function uniqueParts(parts: Array<string | null>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const part of parts) {
    if (!part) continue;
    const key = part.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(part);
  }

  return result;
}

function toGeocodingResult(feature: PhotonFeature): GeocodingResult | null {
  const properties = feature.properties ?? {};
  const coordinates = feature.geometry?.coordinates;

  // GeoJSON coordinates are [longitude, latitude], not [latitude, longitude].
  if (
    !Array.isArray(coordinates) ||
    typeof coordinates[0] !== "number" ||
    typeof coordinates[1] !== "number" ||
    !Number.isFinite(coordinates[0]) ||
    !Number.isFinite(coordinates[1])
  ) {
    return null;
  }

  const longitude = coordinates[0];
  const latitude = coordinates[1];
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
    return null;
  }

  const name = asText(properties.name);
  const houseNumber = asText(properties.housenumber);
  const street = asText(properties.street);
  const district = firstText(
    properties.district,
    properties.suburb,
    properties.locality,
  );
  const city = firstText(
    properties.city,
    properties.town,
    properties.village,
    properties.municipality,
    properties.county,
  );
  const province = asText(properties.state);
  const country = asText(properties.country);
  const streetAddress = [houseNumber, street].filter(Boolean).join(" ") || null;
  const labelParts = uniqueParts([
    name,
    streetAddress,
    district,
    city,
    province,
    country,
  ]);
  const label = labelParts.join(", ");

  if (!label) return null;

  const osmType = asText(properties.osm_type) ?? "place";
  const osmId = properties.osm_id;
  const id =
    osmId !== undefined && osmId !== null
      ? `${osmType}-${String(osmId)}`
      : `${latitude.toFixed(6)}-${longitude.toFixed(6)}`;

  return {
    id,
    label,
    addressLine: streetAddress ?? name ?? label,
    houseNumber,
    street,
    district,
    city,
    province,
    country,
    latitude,
    longitude,
  };
}

function parseCoordinate(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const geocodingRoutes = new Elysia({
  name: "hyops-geocoding-routes",
}).get(
  "/geocoding/search",
  async ({ query, set }): Promise<GeocodingSearchResponse> => {
    const searchTerm = query.q?.trim() ?? "";

    if (searchTerm.length < MIN_QUERY_LENGTH) {
      set.headers["Cache-Control"] = "no-store";
      return { results: [] };
    }

    if (searchTerm.length > MAX_QUERY_LENGTH) {
      set.status = 400;
      return {
        results: [],
        error: `Search must be ${MAX_QUERY_LENGTH} characters or fewer.`,
      };
    }

    const latitude = parseCoordinate(query.lat, DEFAULT_LATITUDE);
    const longitude = parseCoordinate(query.lon, DEFAULT_LONGITUDE);
    const validLatitude =
      latitude >= -90 && latitude <= 90 ? latitude : DEFAULT_LATITUDE;
    const validLongitude =
      longitude >= -180 && longitude <= 180 ? longitude : DEFAULT_LONGITUDE;

    const photonUrl = new URL(PHOTON_API_URL);
    photonUrl.searchParams.set("q", searchTerm);
    photonUrl.searchParams.set("limit", String(RESULT_LIMIT));
    photonUrl.searchParams.set("lang", "en");
    photonUrl.searchParams.set("countrycode", "PH");
    photonUrl.searchParams.set("lat", String(validLatitude));
    photonUrl.searchParams.set("lon", String(validLongitude));

    try {
      const photonResponse = await fetch(photonUrl, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      });

      if (!photonResponse.ok) {
        set.status = 502;
        return {
          results: [],
          error: "The address search service is temporarily unavailable.",
        };
      }

      const payload = (await photonResponse.json()) as PhotonFeatureCollection;
      const results = (payload.features ?? [])
        .map(toGeocodingResult)
        .filter((result): result is GeocodingResult => result !== null);

      set.headers["Cache-Control"] = "no-store";
      return { results };
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === "TimeoutError";
      set.status = isTimeout ? 504 : 502;
      return {
        results: [],
        error: isTimeout
          ? "Address search timed out. Please try again."
          : "Unable to search addresses right now. Please try again.",
      };
    }
  },
  {
    query: t.Object({
      q: t.Optional(t.String()),
      lat: t.Optional(t.String()),
      lon: t.Optional(t.String()),
    }),
    detail: {
      summary: "Search address suggestions",
      description:
        "Searches Photon/OpenStreetMap and returns normalized address details and GPS coordinates.",
      tags: ["Geocoding"],
    },
  },
);
