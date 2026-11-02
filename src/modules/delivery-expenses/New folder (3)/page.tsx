"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type EstimateResponse = {
  route: {
    distanceKm: number;
    durationMinutes: number;
    geometry: { type: "LineString"; coordinates: [number, number][] };
  };
  tollDetection: {
    status: "DETECTED" | "NO_TOLL_TAG_FOUND" | "UNAVAILABLE";
    hasToll: boolean | null;
    source: "OpenStreetMap" | "Project OSRM (road-name heuristic)";
    roads: { osmWayId: number; name: string | null; ref: string | null; tollTag: string; matchedRouteEdges: number }[];
    tollPoints: { osmNodeId: number; type: "TOLL_BOOTH" | "TOLL_GANTRY"; name: string | null; ref: string | null }[];
    matchedRoadNames: { expressway: string; name: string | null; ref: string | null; matchedStepCount: number; distanceKm: number }[];
    note: string;
  };
  expenses: {
    driverAllowance: number;
    estimatedFuelLiters: number;
    estimatedFuelCost: number;
    hasToll: boolean | null;
    estimatedTollFee: number | null;
    estimatedTotal: number | null;
    estimatedTotalExcludingUnknownToll: number;
    tollFeeStatus: string;
  };
};

const peso = (value: number) => new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(value);

export default function Page() {
  const [estimate, setEstimate] = useState<EstimateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function calculateEstimate() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/delivery-estimates", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          points: [
            { latitude: 14.80219, longitude: 120.94192 }, // Bocaue Toll Plaza area
            { latitude: 15.17979, longitude: 120.60277 }, // Dau Tollbooth area
          ],
          isRoundTrip: false,
        }),
      });

      const raw = await response.text();
      let data: unknown = null;
      try { data = raw ? JSON.parse(raw) : null; } catch { /* non-JSON error */ }
      if (!response.ok) {
        const message = data && typeof data === "object" && "message" in data && typeof data.message === "string"
          ? data.message
          : raw || `Request failed (HTTP ${response.status})`;
        throw new Error(message);
      }
      setEstimate(data as EstimateResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Delivery Expense Estimator</h1>
        <p className="text-sm text-muted-foreground">OSRM route calculation with toll-detection fallback.</p>
      </div>
      <Button onClick={calculateEstimate} disabled={loading}>{loading ? "Calculating..." : "Calculate Expenses"}</Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {estimate && <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card><CardHeader><CardTitle>Distance</CardTitle></CardHeader><CardContent>{estimate.route.distanceKm.toFixed(2)} km</CardContent></Card>
          <Card><CardHeader><CardTitle>Duration</CardTitle></CardHeader><CardContent>{estimate.route.durationMinutes} minutes</CardContent></Card>
          <Card><CardHeader><CardTitle>Driver Allowance</CardTitle></CardHeader><CardContent>{peso(estimate.expenses.driverAllowance)}</CardContent></Card>
          <Card><CardHeader><CardTitle>Fuel</CardTitle></CardHeader><CardContent>{peso(estimate.expenses.estimatedFuelCost)}<p className="text-sm text-muted-foreground">{estimate.expenses.estimatedFuelLiters.toFixed(2)} L</p></CardContent></Card>
        </div>
        <Card><CardHeader><CardTitle>Toll Road Detection</CardTitle></CardHeader><CardContent className="space-y-3">
          <p className="font-medium">{estimate.tollDetection.status === "DETECTED" ? "Toll road likely detected" : estimate.tollDetection.status === "UNAVAILABLE" ? "Detection unavailable" : "No toll tags matched"}</p>
          <p className="text-sm text-muted-foreground">Source: {estimate.tollDetection.source}</p>
          <p className="text-sm text-muted-foreground">{estimate.tollDetection.note}</p>
          {estimate.tollDetection.matchedRoadNames.map((road) => <div key={road.expressway} className="rounded-md border p-3 text-sm">
            <p className="font-medium">{road.expressway}</p>
            <p className="text-muted-foreground">OSRM name: {road.name ?? "Not provided"} · Ref: {road.ref ?? "Not provided"}</p>
            <p className="text-muted-foreground">Matched steps: {road.matchedStepCount} · Distance on matched steps: {road.distanceKm.toFixed(2)} km</p>
          </div>)}
          {estimate.tollDetection.roads.map((road) => <div key={road.osmWayId} className="rounded-md border p-3 text-sm"><p className="font-medium">{road.name ?? road.ref ?? `OSM way ${road.osmWayId}`}</p><p className="text-muted-foreground">{road.tollTag} · matched route edges: {road.matchedRouteEdges}</p></div>)}
          {estimate.tollDetection.tollPoints.map((point) => <div key={point.osmNodeId} className="rounded-md border p-3 text-sm">{point.name ?? point.ref ?? `OSM node ${point.osmNodeId}`} — {point.type}</div>)}
        </CardContent></Card>
        <Card><CardHeader><CardTitle>Estimated Toll</CardTitle></CardHeader><CardContent><p className="text-2xl font-semibold">{estimate.expenses.estimatedTollFee === null ? "Unknown — fee lookup needed" : peso(estimate.expenses.estimatedTollFee)}</p></CardContent></Card>
        <Card><CardHeader><CardTitle>Total Estimated Expenses</CardTitle></CardHeader><CardContent>{estimate.expenses.estimatedTotal === null ? <><p className="text-2xl font-semibold">{peso(estimate.expenses.estimatedTotalExcludingUnknownToll)} + toll</p><p className="text-sm text-muted-foreground">Subtotal excludes the unknown toll fee.</p></> : <p className="text-2xl font-semibold">{peso(estimate.expenses.estimatedTotal)}</p>}</CardContent></Card>
      </div>}
    </div>
  );
}
