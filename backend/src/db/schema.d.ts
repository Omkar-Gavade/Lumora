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

/**
 * One retrievable passage.
 *
 * `content_tsv` is `never` on both insert and update: Postgres generates it and
 * rejects any statement that supplies a value, so the type turns a runtime
 * error into a compile error.
 */
export interface DocumentChunksTable {
  id: Generated<string>;
  document_id: string;
  /** Denormalized tenant filter for lexical search — see migration 0005. */
  user_id: string;
  chunk_index: number;
  content: string;
  token_count: number;
  page_number: number | null;
  section_path: string | null;
  char_start: number | null;
  char_end: number | null;
  vector_id: string | null;
  content_tsv: ColumnType<string, never, never>;
  created_at: ColumnType<Date, string | undefined, never>;
}

/** Append-only cost ledger; rows are never updated. */
export interface UsageEventsTable {
  id: Generated<string>;
  user_id: string;
  kind: string;
  model: string;
  input_tokens: Generated<number>;
  output_tokens: Generated<number>;
  cost_micros: ColumnType<string, string | number | undefined, never>;
  created_at: ColumnType<Date, string | undefined, never>;
}

export interface ConversationsTable {
  id: Generated<string>;
  user_id: string;
  title: Generated<string>;
  title_generated: Generated<boolean>;
  /** The rolling summary from docs/05 §4.4. Not written by M6a. */
  summary: string | null;
  summary_upto_seq: number | null;
  message_count: Generated<number>;
  last_message_at: ColumnType<Date | null, string | null, string | null>;
  archived_at: ColumnType<Date | null, string | null, string | null>;
  /** Retrieval scope (docs/07 §5). `null` is unscoped — the existing behaviour. */
  knowledge_base_id: ColumnType<string | null, string | null, string | null>;
  created_at: ColumnType<Date, string | undefined, never>;
  updated_at: ColumnType<Date, string | undefined, string | undefined>;
}

export interface KnowledgeBasesTable {
  id: Generated<string>;
  user_id: string;
  name: string;
  description: string | null;
  created_at: ColumnType<Date, string | undefined, never>;
  updated_at: ColumnType<Date, string | undefined, string | undefined>;
}

/**
 * The pgvector index (docs/08 §6).
 *
 * A **derived** table: every column is reconstructible from `document_chunks`
 * and `documents`, which is what makes losing it a re-embedding cost rather
 * than data loss. `embedding` is deliberately absent from this type — it is a
 * `vector(768)` that Kysely has no representation for, and nothing outside
 * `PgVectorStore` (which uses raw SQL) should be reading or writing it.
 */
export interface DocumentVectorsTable {
  collection: string;
  id: string;
  text: string;
  chunk_id: string;
  document_id: string;
  user_id: string;
  document_name: string;
  chunk_index: number;
  page_number: number | null;
  section_path: string | null;
  created_at: ColumnType<Date, string | undefined, never>;
}

/** Many-to-many membership. The composite PK is the dedup (docs/07 §5.1). */
export interface KnowledgeBaseDocumentsTable {
  knowledge_base_id: string;
  document_id: string;
  created_at: ColumnType<Date, string | undefined, never>;
}

/** Matches the `message_role` enum. */
export type MessageRole = 'user' | 'assistant' | 'system';

/**
 * Matches the `message_status` enum.
 *
 * `pending` and `streaming` exist because the row is written before the model
 * is called (docs/05 §7 step 3) — see the migration for why.
 */
export type MessageStatus = 'pending' | 'streaming' | 'complete' | 'stopped' | 'failed';

export interface MessagesTable {
  id: Generated<string>;
  conversation_id: string;
  /** Denormalized owner — see migration 0006. */
  user_id: string;
  role: MessageRole;
  content: Generated<string>;
  status: Generated<MessageStatus>;
  sequence: number;
  /** Regeneration lineage; never a mutation in place. */
  parent_id: string | null;
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  latency_ms: number | null;
  finish_reason: string | null;
  error_code: string | null;
  created_at: ColumnType<Date, string | undefined, never>;
}

/**
 * A citation, with the cited text frozen at answer time.
 *
 * No `created_at`: the row's lifetime is the message's, and a second timestamp
 * that is always within microseconds of `messages.created_at` is a column that
 * answers no question.
 */
export interface MessageCitationsTable {
  id: Generated<string>;
  message_id: string;
  chunk_id: string;
  document_id: string;
  citation_index: number;
  score: number;
  content_snapshot: string;
}

export interface DB {
  schema_migrations: SchemaMigrationsTable;
  users: UsersTable;
  refresh_tokens: RefreshTokensTable;
  verification_tokens: VerificationTokensTable;
  documents: DocumentsTable;
  jobs: JobsTable;
  document_chunks: DocumentChunksTable;
  usage_events: UsageEventsTable;
  conversations: ConversationsTable;
  messages: MessagesTable;
  message_citations: MessageCitationsTable;
  knowledge_bases: KnowledgeBasesTable;
  knowledge_base_documents: KnowledgeBaseDocumentsTable;
  document_vectors: DocumentVectorsTable;
}
