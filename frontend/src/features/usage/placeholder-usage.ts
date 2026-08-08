/**
 * Storage figures shown in the sidebar and Settings, pending `GET
 * /users/me/usage` (docs/04-data-and-api.md §2.2, arriving with documents in
 * M3).
 *
 * Isolated in one exported constant rather than left inline, so the wiring is
 * a single import to delete rather than a hunt through two components. Named
 * `PLACEHOLDER_` so it cannot be mistaken for real data at a call site, and
 * kept deliberately separate from the user object: putting invented numbers on
 * a real `UserDto` is how mock data survives into production.
 */
export interface StorageUsage {
  usedBytes: number;
  limitBytes: number;
  documentCount: number;
}

/**
 * Typed rather than `as const`: literal types would make ordinary comparisons
 * like `documentCount === 1` a compile error today and then start compiling
 * the moment real data arrives — a type that changes shape under you is worse
 * than no type.
 */
export const PLACEHOLDER_USAGE: StorageUsage = {
  usedBytes: 0,
  limitBytes: 5_368_709_120, // 5 GB
  documentCount: 0,
};
