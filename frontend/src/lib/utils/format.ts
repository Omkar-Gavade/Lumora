/**
 * Storage sizes, in the units storage is actually sold in.
 *
 * Binary units (1024) with decimal labels ("GB") is what every operating
 * system and every storage plan does, so matching it means the number in the
 * sidebar equals the number on the invoice. One decimal below 10, none above —
 * "1.2 GB" is informative, "1.24 GB" is noise and "12.8 GB" is false precision.
 */
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';

  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  const unit = UNITS[exponent] ?? 'B';
  const decimals = exponent === 0 || value >= 10 ? 0 : 1;

  return `${value.toFixed(decimals)} ${unit}`;
}

/** "1.2 GB of 5 GB" — the phrasing a usage meter needs. */
export function formatBytesOf(used: number, limit: number): string {
  return `${formatBytes(used)} of ${formatBytes(limit)}`;
}
