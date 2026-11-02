# HYOps OSRM toll-road fallback

This patch keeps Project OSRM as the route engine and adds a **road-name heuristic** when the OpenStreetMap Overpass toll-tag lookup is unavailable or returns no matching toll tags.

## What changes

- `osrm.ts` requests `steps=true` and `annotations=nodes`. It now returns `roadSegments` with the route-step `name`, `ref`, and distance.
- `toll-detection.ts` continues to prefer actual OpenStreetMap toll tags. It adds `detectTollRoadsFromOsrmRoadNames`, which recognizes well-known Philippine toll expressways when their names or refs appear in OSRM steps (NLEX, SCTEX, TPLEX, SLEX, Skyway, STAR Tollway, CALAX, CAVITEX, MCX, NAIAX and CCLEX).
- `index.ts` uses the OSRM name heuristic if the Overpass lookup is unavailable or no toll tags matched. It also logs the Overpass error instead of discarding its details.
- The fee and final total remain unknown unless `tollFeeOverride` is provided. Neither Project OSRM nor this name heuristic returns a tariff.
- `page.tsx` is a sample UI updated to display the OSRM road-name fallback result.

## Request

```json
{
  "points": [
    { "latitude": 14.80219, "longitude": 120.94192 },
    { "latitude": 15.17979, "longitude": 120.60277 }
  ],
  "isRoundTrip": false
}
```

The old `hasToll` and `estimatedTollFee` fields are not needed. Use `tollFeeOverride` only when a tariff amount is known; for example, set `tollFeeOverride: 0` only if your staff or another reliable source has confirmed that the route has no toll cost.

## Important limitations

Project OSRM exposes road-step names and refs, not a toll boolean or toll price. This fallback is **heuristic**: it may miss a toll road if the name/ref is missing, may be ambiguous, and only covers the expressway aliases listed in the code. An OSRM name match means a known expressway appears in the route step names; it is not an official tariff estimate. OSM toll tags remain the preferred positive detector when available.

To install, copy the backend `osrm.ts`, `toll-detection.ts`, and `index.ts` into your Elysia route directory. `delivery-expense.ts` is included unchanged. Use `page.tsx` only if you want the matching frontend example; check your component import paths before replacing an existing page.
