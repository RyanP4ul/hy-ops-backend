// Configure a preferred endpoint with OVERPASS_API_URL if you operate your own
// instance. Public instances can become overloaded, so try independent mirrors
// before the canonical endpoint.
const runtimeProcess = (
  globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  }
).process;

const OVERPASS_ENDPOINTS = [
  runtimeProcess?.env?.OVERPASS_API_URL,
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass-api.de/api/interpreter",
].filter((url): url is string => Boolean(url));

const NODE_BATCH_SIZE = 800;
const MAX_ROUTE_NODES = 6_400;
const OVERPASS_REQUEST_TIMEOUT_MS = 18_000;

export type TollDetectionStatus =
  | "DETECTED"
  | "NO_TOLL_TAG_FOUND"
  | "UNAVAILABLE";

export interface TollRoadMatch {
  osmWayId: number;
  name: string | null;
  ref: string | null;
  highway: string | null;
  tollTag: string;
  matchedRouteEdges: number;
}

export interface TollPointMatch {
  osmNodeId: number;
  type: "TOLL_BOOTH" | "TOLL_GANTRY";
  name: string | null;
  ref: string | null;
}

export interface TollDetectionResult {
  status: TollDetectionStatus;
  /** null means the OSM lookup failed or route node IDs were unavailable. */
  hasToll: boolean | null;
  source: "OpenStreetMap";
  roads: TollRoadMatch[];
  tollPoints: TollPointMatch[];
  note: string;
}

interface OverpassElement {
  type: "node" | "way";
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements?: OverpassElement[];
}

/**
 * Tries the configured Overpass endpoint and then public mirrors. A failure
 * on one instance should not prevent HYOps from checking the route elsewhere.
 */
async function postToOverpass(query: string): Promise<OverpassResponse> {
  const failures: string[] = [];

  for (let index = 0; index < OVERPASS_ENDPOINTS.length; index += 1) {
    const endpoint = OVERPASS_ENDPOINTS[index]!;
    let endpointName = endpoint;

    try {
      endpointName = new URL(endpoint).host;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
          "user-agent": "HYOps-delivery-estimate/1.0",
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(OVERPASS_REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const details = (await response.text())
          .slice(0, 300)
          .replace(/\s+/g, " ");
        failures.push(
          `${endpointName}: HTTP ${response.status}${details ? ` - ${details}` : ""}`,
        );
      } else {
        return (await response.json()) as OverpassResponse;
      }
    } catch (error) {
      failures.push(
        `${endpointName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Brief exponential backoff before trying the next independent server.
    if (index < OVERPASS_ENDPOINTS.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** index));
    }
  }

  throw new Error(
    `All Overpass endpoints failed. ${failures.join(" | ") || "No endpoints configured."}`,
  );
}

const affirmativeTollValues = new Set(["yes", "1", "true", "hgv"]);

function isTollForTruck(tags: Record<string, string>): boolean {
  const hgvToll = tags["toll:hgv"]?.toLowerCase();

  // Respect an explicit OSM tag saying that heavy goods vehicles are exempt.
  if (hgvToll === "no") return false;

  const generalToll = tags.toll?.toLowerCase();
  return (
    (generalToll !== undefined && affirmativeTollValues.has(generalToll)) ||
    (hgvToll !== undefined && affirmativeTollValues.has(hgvToll))
  );
}

function matchedAdjacentRouteEdges(
  routeNodeIds: number[],
  wayNodeIds: number[],
): number {
  if (routeNodeIds.length < 2 || wayNodeIds.length < 2) return 0;

  // Use adjacent OSM node pairs, not just shared intersections. This helps
  // avoid reporting a toll road that merely crosses the chosen route.
  const wayEdges = new Set<string>();
  for (let i = 0; i < wayNodeIds.length - 1; i += 1) {
    const a = wayNodeIds[i];
    const b = wayNodeIds[i + 1];
    wayEdges.add(`${a}:${b}`);
    wayEdges.add(`${b}:${a}`);
  }

  let matchedEdges = 0;
  for (let i = 0; i < routeNodeIds.length - 1; i += 1) {
    if (wayEdges.has(`${routeNodeIds[i]}:${routeNodeIds[i + 1]}`)) {
      matchedEdges += 1;
    }
  }
  return matchedEdges;
}

async function queryOverpass(
  routeNodeIds: number[],
): Promise<OverpassElement[]> {
  const ids = [...new Set(routeNodeIds)];

  if (ids.length === 0) {
    throw new Error("OSRM did not return OSM node IDs for this route.");
  }

  if (ids.length > MAX_ROUTE_NODES) {
    throw new Error(
      `Route contains too many OSM nodes to check in one estimate (${ids.length}).`,
    );
  }

  const elementsByKey = new Map<string, OverpassElement>();

  // Keep request sizes manageable and avoid sending a very large query to
  // the shared Overpass service. Queries are sequential to limit load.
  for (let offset = 0; offset < ids.length; offset += NODE_BATCH_SIZE) {
    const nodeBatch = ids.slice(offset, offset + NODE_BATCH_SIZE);
    const query = `
[out:json][timeout:15];
node(id:${nodeBatch.join(",")})->.routeNodes;
(
  node.routeNodes["barrier"="toll_booth"];
  node.routeNodes["highway"="toll_gantry"];
  way(bn.routeNodes)["toll"~"^(yes|1|true|hgv)$"];
  way(bn.routeNodes)["toll:hgv"~"^(yes|1|true)$"];
);
out body;
`;

    const data = await postToOverpass(query);
    for (const element of data.elements ?? []) {
      elementsByKey.set(`${element.type}:${element.id}`, element);
    }
  }

  return [...elementsByKey.values()];
}

export function unavailableTollDetection(note?: string): TollDetectionResult {
  return {
    status: "UNAVAILABLE",
    hasToll: null,
    source: "OpenStreetMap",
    roads: [],
    tollPoints: [],
    note:
      note ??
      "Toll checking is temporarily unavailable. Review the route manually; the route and fuel estimate are still available.",
  };
}

/**
 * Checks OSRM's route node IDs against OSM toll-tagged road ways and toll
 * booth/gantry nodes. For HYOps, toll:hgv tags are considered because the
 * delivery vehicles are trucks. This detects mapped toll infrastructure; it
 * does not calculate a tariff or guarantee that OSM tagging is complete.
 */
export async function detectTollRoads(
  routeNodeIds: number[],
): Promise<TollDetectionResult> {
  const elements = await queryOverpass(routeNodeIds);
  const uniqueRouteNodes = [...new Set(routeNodeIds)];
  const routeNodeSet = new Set(uniqueRouteNodes);

  const roads: TollRoadMatch[] = [];
  const tollPoints: TollPointMatch[] = [];

  for (const element of elements) {
    const tags = element.tags ?? {};

    if (element.type === "way") {
      if (!isTollForTruck(tags)) continue;

      const matchedRouteEdges = matchedAdjacentRouteEdges(
        routeNodeIds,
        element.nodes ?? [],
      );
      if (matchedRouteEdges < 1) continue;

      const tollTag =
        tags["toll:hgv"] && tags["toll:hgv"] !== "no"
          ? `toll:hgv=${tags["toll:hgv"]}`
          : `toll=${tags.toll ?? "unknown"}`;

      roads.push({
        osmWayId: element.id,
        name: tags.name ?? null,
        ref: tags.ref ?? null,
        highway: tags.highway ?? null,
        tollTag,
        matchedRouteEdges,
      });
      continue;
    }

    // Toll booth / gantry nodes must be nodes actually included in the OSRM
    // route, not just nearby map features.
    if (!routeNodeSet.has(element.id) || tags["toll:hgv"] === "no") continue;

    if (tags.barrier === "toll_booth") {
      tollPoints.push({
        osmNodeId: element.id,
        type: "TOLL_BOOTH",
        name: tags.name ?? null,
        ref: tags.ref ?? null,
      });
    } else if (tags.highway === "toll_gantry") {
      tollPoints.push({
        osmNodeId: element.id,
        type: "TOLL_GANTRY",
        name: tags.name ?? null,
        ref: tags.ref ?? null,
      });
    }
  }

  const uniqueRoads = [
    ...new Map(roads.map((road) => [road.osmWayId, road])).values(),
  ];
  const uniqueTollPoints = [
    ...new Map(tollPoints.map((point) => [point.osmNodeId, point])).values(),
  ];
  const hasToll = uniqueRoads.length > 0 || uniqueTollPoints.length > 0;

  return {
    status: hasToll ? "DETECTED" : "NO_TOLL_TAG_FOUND",
    hasToll,
    source: "OpenStreetMap",
    roads: uniqueRoads,
    tollPoints: uniqueTollPoints,
    note: hasToll
      ? "A toll-tagged road segment or toll point matched the selected route. Toll fee is not supplied by OSRM/OSM and must be looked up separately."
      : "No truck-toll-tagged segment, toll booth, or toll gantry was matched. OpenStreetMap tagging may be incomplete, so this does not guarantee the route is toll-free.",
  };
}
