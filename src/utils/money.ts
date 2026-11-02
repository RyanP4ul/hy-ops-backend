export function moneyToMinorUnits(value: number | string): bigint {
  const normalized = String(value);
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(normalized);

  if (!match) {
    throw new Error(
      "Money values must be valid and have at most 2 decimal places.",
    );
  }

  const fraction = (match[3] ?? "").padEnd(2, "0");
  const minorUnits = BigInt(match[2]) * 100n + BigInt(fraction || "0");
  return match[1] === "-" ? -minorUnits : minorUnits;
}

export function minorUnitsToMoney(value: bigint): string {
  const absolute = value < 0n ? -value : value;
  const formatted = `${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
  return value < 0n ? `-${formatted}` : formatted;
}
