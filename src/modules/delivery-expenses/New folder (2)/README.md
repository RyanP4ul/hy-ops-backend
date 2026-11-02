# HYOps OSRM toll-road detection patch

This patch keeps Project OSRM as the route engine and queries OpenStreetMap's Overpass API to check the route's OSM node IDs against:

- road ways tagged `toll=yes` (or equivalent values)
- truck-specific `toll:hgv=yes` ways
- `barrier=toll_booth` nodes
- `highway=toll_gantry` nodes

## Files

Copy `osrm.ts`, `toll-detection.ts`, `delivery-expense.ts`, and `index.ts` into the same backend route folder, preserving or adjusting the relative import paths for your project.

## Overpass endpoint fallback

The toll detector tries `OVERPASS_API_URL` first if it is configured, followed by these public mirrors:

1. `https://overpass.private.coffee/api/interpreter`
2. `https://maps.mail.ru/osm/tools/overpass/api/interpreter`
3. `https://overpass-api.de/api/interpreter`

Each request has an 18-second timeout and failures move to the next endpoint with a short exponential delay. You can set `OVERPASS_API_URL` in the backend environment to prioritize an instance you manage. Public instances can still become unavailable, so the caller should continue handling `UNAVAILABLE` results gracefully.

## Request body

`hasToll` is now detected automatically. A fee cannot be calculated from OSRM alone, so staff or a future tariff lookup may send `tollFeeOverride`:

```json
{
  "points": [
    { "latitude": 14.81, "longitude": 120.91 },
    { "latitude": 14.70, "longitude": 120.98 }
  ],
  "isRoundTrip": false,
  "tollFeeOverride": 350
}
```

`tollFeeOverride` is optional and must be the total toll estimate for the full planned trip. When `isRoundTrip` is true, include the return trip tolls in the override.

The old `hasToll` and `estimatedTollFee` request fields are accepted only for compatibility, but ignored. Remove them from the frontend request and use `tollFeeOverride` only when a user has actually supplied a tariff estimate.

## Response behavior

- `tollDetection.status = "DETECTED"`: toll-tagged route segments or toll points matched.
- `tollDetection.status = "NO_TOLL_TAG_FOUND"`: no matching tags were found; this does **not** guarantee the route is toll-free.
- `tollDetection.status = "UNAVAILABLE"`: node metadata was missing or the Overpass lookup failed.
- If toll is detected and there is no `tollFeeOverride`, `expenses.estimatedTollFee` and `expenses.estimatedTotal` are `null`; `estimatedTotalExcludingUnknownToll` still provides the allowance + fuel estimate.
- When a manual toll override is supplied, `estimatedTotal` includes it.

## Limitations and production notes

1. OSRM returns route distance, time, geometry, and node annotations; it does not provide toll fares.
2. OSM data can be incomplete or incorrectly tagged. This method is a useful detector, not a legal or guaranteed toll-free route check.
3. Philippine expressway fares depend on the toll road, entry/exit pair, direction/system, and vehicle class (for example, Class 1/2/3). To calculate a fee automatically, add an updated toll-plaza/tariff dataset or a reliable licensed toll-pricing API and identify the route's actual entry and exit plazas. Do not estimate by multiplying total distance by a single nationwide rate.
4. Overpass is a shared public service and may rate-limit requests. For production, consider caching route-node lookups, using a managed/self-hosted Overpass instance, or failing gracefully as this endpoint does.
