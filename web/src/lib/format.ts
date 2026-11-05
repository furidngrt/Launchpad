import { formatUnits } from "viem";

const WAD = 10n ** 18n;
const SUBSCRIPT = "₀₁₂₃₄₅₆₇₈₉";

function trim(value: string): string {
  if (!value.includes(".")) return value;
  return value.replace(/0+$/, "").replace(/\.$/, "");
}

function groupThousands(integer: string): string {
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** An amount of the native asset, at a precision that suits its size. */
export function formatEth(wei: bigint | undefined, maxDecimals = 4): string {
  if (wei === undefined) return "—";
  if (wei === 0n) return "0";
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const text = formatUnits(abs, 18);
  const [integer, fraction = ""] = text.split(".");
  let decimals = maxDecimals;
  if (integer === "0") {
    // Keep a few significant digits for small amounts instead of rounding
    // them away to zero.
    const leading = fraction.match(/^0*/)?.[0].length ?? 0;
    decimals = Math.max(maxDecimals, leading + 3);
  }
  const shown = trim(`${groupThousands(integer)}.${fraction.slice(0, decimals)}`);
  return `${negative ? "-" : ""}${shown === "0" ? "<0.0001" : shown}`;
}

/** Token quantities in a compact form: 714.29M, 12.4K. */
export function formatCompact(amount: bigint | undefined, decimals = 18): string {
  if (amount === undefined) return "—";
  const value = Number(formatUnits(amount, decimals));
  if (value === 0) return "0";
  const units: [number, string][] = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, suffix] of units) {
    if (Math.abs(value) >= size) return `${trim((value / size).toFixed(2))}${suffix}`;
  }
  if (Math.abs(value) < 0.01) return "<0.01";
  return trim(value.toFixed(2));
}

/**
 * A per-token price in the native asset, scaled by 1e18. Very small prices are
 * written with a subscript count of leading zeros, so 0.00000000168 reads as
 * 0.0₈168 rather than as a row of zeros or scientific notation.
 */
export function formatPrice(priceWad: bigint | undefined): string {
  if (priceWad === undefined) return "—";
  if (priceWad === 0n) return "0";
  const text = formatUnits(priceWad, 18);
  const [integer, fraction = ""] = text.split(".");
  if (integer !== "0") return trim(`${groupThousands(integer)}.${fraction.slice(0, 4)}`);
  const zeros = fraction.match(/^0*/)?.[0].length ?? 0;
  const digits = fraction.slice(zeros, zeros + 4).replace(/0+$/, "") || "0";
  if (zeros < 4) return `0.${"0".repeat(zeros)}${digits}`;
  const sub = String(zeros)
    .split("")
    .map((d) => SUBSCRIPT[Number(d)])
    .join("");
  return `0.0${sub}${digits}`;
}

export function formatPercent(bps: bigint | number | undefined, digits = 1): string {
  if (bps === undefined) return "—";
  const value = Number(bps) / 100;
  return `${trim(value.toFixed(digits))}%`;
}

export function shortAddress(address: string | undefined): string {
  if (!address) return "—";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function timeAgo(seconds: number): string {
  const delta = Math.max(0, Math.floor(Date.now() / 1000 - seconds));
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

/** Price per token, scaled by 1e18, from a pair of reserves. */
export function priceFromReserves(quoteReserve: bigint, tokenReserve: bigint): bigint {
  if (tokenReserve === 0n) return 0n;
  return (quoteReserve * WAD) / tokenReserve;
}

/** Valuation at a price: price times supply. */
export function valuation(priceWad: bigint, supply: bigint): bigint {
  return (priceWad * supply) / WAD;
}

/** Turns an ipfs:// reference into something a browser can load. */
export function resolveMedia(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  const trimmed = uri.trim();
  if (trimmed.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${trimmed.slice(7)}`;
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith("data:image/")) return trimmed;
  return undefined;
}

export function safeLink(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  const trimmed = uri.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : undefined;
}

/** A price as a plain number, for chart axes: 0.0₁₀1571 style below 0.001. */
export function formatPriceNumber(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1) return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
  if (value >= 0.001) return trim(value.toPrecision(4));
  const exponent = Math.floor(Math.log10(value));
  const zeros = -exponent - 1;
  const digits = (value / 10 ** exponent).toFixed(3).replace(".", "").replace(/0+$/, "") || "0";
  const sub = String(zeros)
    .split("")
    .map((d) => SUBSCRIPT[Number(d)])
    .join("");
  return `0.0${sub}${digits}`;
}

/** A change in basis points as a signed percentage or multiple. */
export function formatChange(bps: number): string {
  if (bps >= 100_000) return `${trim((bps / 10_000 + 1).toFixed(1))}x`;
  const value = bps / 100;
  return `${value >= 0 ? "+" : ""}${trim(value.toFixed(Math.abs(value) >= 100 ? 0 : 1))}%`;
}

/** Compact age: 45s, 12m, 3h, 2d, 3mo. */
export function formatAge(seconds: number | undefined): string {
  if (seconds === undefined) return "";
  const delta = Math.max(0, Math.floor(Date.now() / 1000 - seconds));
  if (delta < 60) return `${delta}s`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  if (delta < 86400 * 30) return `${Math.floor(delta / 86400)}d`;
  return `${Math.floor(delta / (86400 * 30))}mo`;
}
