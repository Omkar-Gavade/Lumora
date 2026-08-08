import type { ColumnType, Generated } from 'kysely';

/**
 * The Kysely schema type — the compile-time mirror of the live database.
 *
 * docs/03-backend.md §2 describes this file as generated, and M0 said
 * `kysely-codegen` would be wired up here. **It is not, and that is a
 * deliberate reversal.** Generation requires a reachable database at build
 * time, which turns `tsc` into something that fails on a laptop with Docker
 * closed and needs a live Postgres in CI before a single type can be checked.
 * Four hand-written tables cost less than that constraint. The file stays
 * shaped exactly as a generator would emit it, so adopting one later is a
 * replacement rather than a rewrite.
 *
 * `ColumnType<Select, Insert, Update>` encodes column behavior in the type
 * system: a database default becomes an optional insert, and an immutable
 * column becomes `never` on update, so a query that tries to change it does
 * not compile.
 */

/** Written only by the migration runner. */
export interface SchemaMigrationsTable {
  version: string;
  name: string;
  checksum: string;
  applied_at: ColumnType<Date, string | undefined, never>;
  duration_ms: number;
}

export interface UsersTable {
  id: Generated<string>;
  email: string;
  password_hash: string;
  display_name: string;
  /** `null` until verified. Nullable timestamp, not a boolean — see migration. */
  email_verified_at: ColumnType<Date | null, string | null, string | null>;
  token_version: Generated<number>;
  failed_login_count: Generated<number>;
  locked_until: ColumnType<Date | null, string | null, string | null>;
  created_at: ColumnType<Date, string | undefined, never>;
  updated_at: ColumnType<Date, string | undefined, string | undefined>;
}

/** Matches the CHECK constraint in 0003; a typo becomes a compile error. */
export type RevokedReason = 'rotated' | 'logout' | 'reuse_detected' | 'password_change';

export interface RefreshTokensTable {
  id: Generated<string>;
  user_id: string;
  token_hash: string;
  family_id: string;
  parent_id: string | null;
  expires_at: ColumnType<Date, string, never>;
  revoked_at: ColumnType<Date | null, string | null, string | null>;
  revoked_reason: ColumnType<RevokedReason | null, RevokedReason | null, RevokedReason | null>;
  user_agent: string | null;
  ip_address: string | null;
  created_at: ColumnType<Date, string | undefined, never>;
}

export type VerificationPurpose = 'email_verification' | 'password_reset';

export interface VerificationTokensTable {
  id: Generated<string>;
  user_id: string;
  token_hash: string;
  purpose: VerificationPurpose;
  expires_at: ColumnType<Date, string, never>;
  consumed_at: ColumnType<Date | null, string | null, string | null>;
  created_at: ColumnType<Date, string | undefined, never>;
}

/** Matches the `document_status` enum; FR-13 shows this sequence to users. */
export type DocumentStatus =
  | 'queued'
  | 'parsing'
  | 'chunking'
  | 'embedding'
  | 'ready'
  | 'failed';

export interface DocumentsTable {
  id: Generated<string>;
  user_id: string;
  filename: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  content_hash: string;
  storage_key: string;
  status: Generated<DocumentStatus>;
  error_code: string | null;
  error_message: string | null;
  page_count: number | null;
  chunk_count: Generated<number>;
  token_count: number | null;
  embedding_model: string | null;
  embedding_dims: number | null;
  processed_at: ColumnType<Date | null, string | null, string | null>;
  created_at: ColumnType<Date, string | undefined, never>;
  updated_at: ColumnType<Date, string | undefined, string | undefined>;
}

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface JobsTable {
  id: Generated<string>;
  type: string;
  /** Validated against a per-type Zod schema before it is enqueued. */
  payload: ColumnType<unknown, string, string>;
  status: Generated<JobStatus>;
  priority: Generated<number>;
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  run_after: ColumnType<Date, string | undefined, string | undefined>;
  locked_at: ColumnType<Date | null, string | null, string | null>;
  locked_by: string | null;
  error: string | null;
  created_at: ColumnType<Date, string | undefined, never>;
  completed_at: ColumnType<Date | null, string | null, string | null>;
}

export interface DB {
  schema_migrations: SchemaMigrationsTable;
  users: UsersTable;
  refresh_tokens: RefreshTokensTable;
  verification_tokens: VerificationTokensTable;
  documents: DocumentsTable;
  jobs: JobsTable;
}
