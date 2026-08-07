import type { ColumnType } from 'kysely';

/**
 * The Kysely schema type — the compile-time mirror of the live database.
 *
 * docs/03-backend.md §2 notes this file is generated. It is hand-written while
 * there is exactly one table, because a code generator producing eight lines is
 * a build step nobody can debug; `kysely-codegen` is wired up in M2, when the
 * identity tables land and the table count makes generation the cheaper option.
 *
 * `ColumnType<Select, Insert, Update>` is what encodes column behavior in the
 * type system: a database default becomes an optional insert, and an immutable
 * column becomes `never` on update, so a query that tries to change it does not
 * compile.
 */

/**
 * Applied migrations. Written only by the runner in `migrate.ts`, and created
 * by it rather than by a migration — a migrations table cannot bootstrap
 * itself from the mechanism it exists to record.
 */
export interface SchemaMigrationsTable {
  /** Numeric prefix of the filename, e.g. `0001`. Sorts lexicographically. */
  version: string;
  /** Descriptive remainder of the filename, for humans reading the table. */
  name: string;
  /** SHA-256 of the file at apply time — detects edits to applied migrations. */
  checksum: string;
  applied_at: ColumnType<Date, string | undefined, never>;
  /** Wall-clock duration of the apply, useful when one starts getting slow. */
  duration_ms: number;
}

export interface DB {
  schema_migrations: SchemaMigrationsTable;
}
