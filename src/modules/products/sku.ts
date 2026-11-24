const PRODUCT_CODE_OVERRIDES: Record<string, string> = {
  tarpaulin: "TP",
  sakolin: "SK",
  sakoline: "SK",
  linoleum: "LN",
};

function normalizeToken(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "");
}

export function deriveProductCode(productName: string): string {
  const cleaned = productName.trim().toLowerCase();
  if (PRODUCT_CODE_OVERRIDES[cleaned]) {
    return PRODUCT_CODE_OVERRIDES[cleaned];
  }

  const words = productName
    .trim()
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);

  if (words.length >= 2) {
    const initials = words
      .map((word) => word[0] ?? "")
      .join("")
      .toUpperCase()
      .slice(0, 4);
    if (initials.length >= 2) return initials;
  }

  const single = normalizeToken(words[0] ?? productName);
  if (!single) return "PRD";

  const consonants = single[0] + single.slice(1).replace(/[AEIOU]/g, "");
  if (consonants.length >= 3) return consonants.slice(0, 3);
  return single.slice(0, 3);
}

export function deriveVariantCode(variantName: string): string {
  const cleaned = variantName
    .trim()
    .toUpperCase()
    .replace(/^\.+/, "")
    .replace(/[^A-Z0-9]+/g, "");

  return (cleaned || "STD").slice(0, 12);
}

export function normalizeSku(sku: string): string {
  return sku
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

export const SKU_PATTERN = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;

export function isValidSku(sku: string): boolean {
  const normalized = normalizeSku(sku);
  return (
    normalized.length >= 3 &&
    normalized.length <= 60 &&
    normalized !== "HY-" &&
    SKU_PATTERN.test(normalized)
  );
}

export function generateHyphenatedSku(
  productName: string,
  variantName: string,
  usedSkus: Iterable<string> = [],
): string {
  const used = new Set<string>();
  for (const sku of usedSkus) {
    if (sku) used.add(normalizeSku(sku));
  }

  const prodCode = deriveProductCode(productName);
  const varCode = deriveVariantCode(variantName);
  const base = `HY-${prodCode}-${varCode}`.slice(0, 56);

  if (!used.has(base)) return base;

  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`.slice(0, 60);
}
