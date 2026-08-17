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

/**
 * "2 hours ago", for timestamps the user reads rather than compares.
 *
 * `Intl.RelativeTimeFormat` rather than a hand-rolled ladder: it is built in,
 * it localises, and it gets the plural rules right in languages where they are
 * not "add an s". The thresholds are the obvious calendar ones; anything older
 * than a week is a date, because "37 days ago" is arithmetic the reader should
 * not have to do.
 */
export function formatRelativeTime(iso: string, now = new Date()): string {
  const then = new Date(iso);
  const seconds = Math.round((then.getTime() - now.getTime()) / 1000);
  const absolute = Math.abs(seconds);

  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  if (absolute < 60) return format.format(Math.round(seconds), 'second');
  if (absolute < 3_600) return format.format(Math.round(seconds / 60), 'minute');
  if (absolute < 86_400) return format.format(Math.round(seconds / 3_600), 'hour');
  if (absolute < 604_800) return format.format(Math.round(seconds / 86_400), 'day');

  return then.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
