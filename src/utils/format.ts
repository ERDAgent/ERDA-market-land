// src/utils/format.ts — price / change / market-cap formatters (§8.3 labels).
//
// Pure functions, locale-aware via `Intl.NumberFormat` for grouping. No THREE
// import. The label renderer (engine/systems/labels.ts) and InfoPanel use the
// same formatters so the label and panel always agree.
//
// Precision rules by magnitude (so big stocks and tiny alts each read cleanly):
//   price >= 1000   → grouped, up to 2 decimals ("1,234.50")
//   1..1000         → 2 decimals ("530.00", "0.52")
//   0.01..1         → 4 decimals
//   < 0.01          → 6 significant decimals

const FMT_GRP = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

/** Format an instrument price for display (no currency symbol — labels are ticker-tagged). */
export function formatPrice(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1000) return FMT_GRP.format(n);
  if (a >= 1) return n.toFixed(2);
  if (a >= 0.01) return n.toFixed(4);
  if (a === 0) return '0';
  return n.toPrecision(6);
}

/** Signed day-change % with exactly 2 decimals, always a leading sign. */
export function formatChangePct(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '-';
  return `${sign}${Math.abs(n).toFixed(2)}%`;
}

/** Human market-cap string: `$2.00 T`, `$300.0 B`, `$12.5 M`, `—` when missing. */
export function formatMarketCap(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e12) return `$${(n / 1e12).toFixed(2)} T`;
  if (a >= 1e9) return `$${(n / 1e9).toFixed(1)} B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(1)} M`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** Human-readable district name from a frozen DistrictId. */
export function districtLabel(id: string): string {
  switch (id) {
    case 'indexes': return 'Indexes';
    case 'tech': return 'Tech';
    case 'finance': return 'Finance';
    case 'healthcare': return 'Healthcare';
    case 'consumer': return 'Consumer';
    case 'energy_industrial': return 'Energy & Industrials';
    case 'crypto': return 'Crypto';
    case 'commodities': return 'Commodities';
    case 'fx': return 'FX';
    default: return id;
  }
}