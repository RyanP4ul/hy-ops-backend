export interface DeliveryExpenseInput {
  distanceKm: number;
  isRoundTrip: boolean;

  // Allowance policy
  allowanceTiers: {
    maxKm: number;
    amount: number;
  }[];
  allowanceOverMax: number;

  // Fuel policy
  fuelConsumptionKmPerLiter: number;
  fuelPricePerLiter: number;

  // Toll inputs used by the expense calculator. The API handler determines
  // these from the toll detection result and an optional manual fee override.
  hasToll: boolean;
  estimatedTollFee: number;
}

export interface DeliveryExpenseEstimate {
  distanceKm: number;
  driverAllowance: number;
  estimatedFuelLiters: number;
  estimatedFuelCost: number;
  hasToll: boolean;
  estimatedTollFee: number;
  estimatedTotal: number;
}

export function estimateDeliveryExpenses(
  input: DeliveryExpenseInput,
): DeliveryExpenseEstimate {
  const {
    distanceKm,
    isRoundTrip,
    allowanceTiers,
    allowanceOverMax,
    fuelConsumptionKmPerLiter,
    fuelPricePerLiter,
    hasToll,
    estimatedTollFee,
  } = input;

  if (!Number.isFinite(distanceKm) || distanceKm < 0) {
    throw new Error("Distance must be a non-negative number.");
  }

  if (
    !Number.isFinite(fuelConsumptionKmPerLiter) ||
    fuelConsumptionKmPerLiter <= 0
  ) {
    throw new Error("Fuel efficiency must be greater than zero.");
  }

  if (!Number.isFinite(fuelPricePerLiter) || fuelPricePerLiter < 0) {
    throw new Error("Fuel price cannot be negative.");
  }

  if (!Number.isFinite(estimatedTollFee) || estimatedTollFee < 0) {
    throw new Error("Toll estimate cannot be negative.");
  }

  const tripDistanceKm = distanceKm * (isRoundTrip ? 2 : 1);

  // Find the first matching allowance tier.
  const sortedTiers = [...allowanceTiers].sort((a, b) => a.maxKm - b.maxKm);
  const matchingTier = sortedTiers.find((tier) => tripDistanceKm <= tier.maxKm);
  const driverAllowance = matchingTier?.amount ?? allowanceOverMax;

  // Fuel estimate based on configured vehicle fuel efficiency.
  const estimatedFuelLiters = tripDistanceKm / fuelConsumptionKmPerLiter;
  const estimatedFuelCost = estimatedFuelLiters * fuelPricePerLiter;
  const tollFee = hasToll ? estimatedTollFee : 0;

  return {
    distanceKm: tripDistanceKm,
    driverAllowance,
    estimatedFuelLiters,
    estimatedFuelCost,
    hasToll,
    estimatedTollFee: tollFee,
    estimatedTotal: driverAllowance + estimatedFuelCost + tollFee,
  };
}
