import { expect, test } from "bun:test";
import { isWarehouseArrival, parseWarehouseArrivalRadius } from "../src/modules/deliveries/warehouse-arrival";

const now = Date.now();
const warehouse = { latitude: "14.5", longitude: "121" };
const fix = { latitude: 14.5, longitude: 121, accuracy_m: 10, recorded_at: new Date(now) };
const since = new Date(now - 5_000);

test("return distance accepts only whole metres from 50 to 1000", () => {
  for (const value of ["50", "100", "150", "1000"]) expect(parseWarehouseArrivalRadius(value)).toBe(Number(value));
  for (const value of [null, undefined, "", " ", "49", "1001", "30000", "100.5", "Infinity", "100ms", "1e2"]) expect(parseWarehouseArrivalRadius(value)).toBeNull();
});
test("custom radius changes the arrival threshold with the same GPS accuracy margin", () => {
  const distantFix = { ...fix, latitude: 14.501, accuracy_m: 10 };
  expect(isWarehouseArrival(distantFix, warehouse, since, now, 100)).toBe(false);
  expect(isWarehouseArrival(distantFix, warehouse, since, now, 150)).toBe(true);
  expect(isWarehouseArrival(fix, warehouse, since, now, NaN)).toBe(false);
});

test("warehouse arrival requires fresh GPS recorded after the return began", () => {
  expect(isWarehouseArrival(fix, warehouse, since, now)).toBe(true);
  for (const age of [60_001, -30_001]) {
    expect(isWarehouseArrival({ ...fix, recorded_at: new Date(now - age) }, warehouse, since, now)).toBe(false);
  }
  expect(isWarehouseArrival(fix, warehouse, new Date(now + 1), now)).toBe(false);
});
test("arrival rejects missing coordinates and poor or missing GPS accuracy", () => {
  for (const accuracy_m of [null, 51, -1, NaN]) expect(isWarehouseArrival({ ...fix, accuracy_m }, warehouse, since, now)).toBe(false);
  for (const latitude of [null, "", "invalid", "91"]) expect(isWarehouseArrival(fix, { ...warehouse, latitude }, since, now)).toBe(false);
});
test("arrival is restricted to the assigned warehouse and accounts for GPS uncertainty", () => {
  expect(isWarehouseArrival(fix, { latitude: 14.6, longitude: 121.1 }, since, now)).toBe(false);
  const nearEdge = { ...fix, latitude: 14.5008 };
  expect(isWarehouseArrival({ ...nearEdge, accuracy_m: 5 }, warehouse, since, now)).toBe(true);
  expect(isWarehouseArrival({ ...nearEdge, accuracy_m: 20 }, warehouse, since, now)).toBe(false);
  expect(isWarehouseArrival({ ...fix, latitude: 14.501 }, warehouse, since, now)).toBe(false);
});
