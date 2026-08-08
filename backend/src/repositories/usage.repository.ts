import { db } from '../db/pool.js';
import type { Executor } from './user.repository.js';

export interface UsageEventInput {
  userId: string;
  /** `'embedding'` | `'completion'` (docs/04-data-and-api.md §1.1). */
  kind: 'embedding' | 'completion';
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Integer micros. Floating-point currency is a bug waiting for a spreadsheet. */
  costMicros?: number;
}

/**
 * SQL for `usage_events`.
 *
 * docs/06-roadmap.md R3: recorded "from M3 so cost is visible rather than
 * discovered on a bill". Append-only — a usage ledger that can be edited is
 * not a ledger.
 */
export const usageRepository = {
  async record(input: UsageEventInput, executor: Executor = db): Promise<void> {
    await executor
      .insertInto('usage_events')
      .values({
        user_id: input.userId,
        kind: input.kind,
        model: input.model,
        ...(input.inputTokens === undefined ? {} : { input_tokens: input.inputTokens }),
        ...(input.outputTokens === undefined ? {} : { output_tokens: input.outputTokens }),
        // Sent as a string: the column is BIGINT, and passing a JS number
        // through a driver that may round is exactly the class of bug integer
        // money exists to prevent.
        ...(input.costMicros === undefined ? {} : { cost_micros: String(input.costMicros) }),
      })
      .execute();
  },

  /** Totals per model for one user — what `GET /users/me/usage` will report. */
  async summaryFor(
    userId: string,
    executor: Executor = db,
  ): Promise<{ kind: string; model: string; inputTokens: number; costMicros: number }[]> {
    const rows = await executor
      .selectFrom('usage_events')
      .select((eb) => [
        'kind',
        'model',
        eb.fn.sum<string>('input_tokens').as('input_tokens'),
        eb.fn.sum<string>('cost_micros').as('cost_micros'),
      ])
      .where('user_id', '=', userId)
      .groupBy(['kind', 'model'])
      .execute();

    return rows.map((row) => ({
      kind: row.kind,
      model: row.model,
      // SUM comes back as a string from a BIGINT-capable driver.
      inputTokens: Number(row.input_tokens),
      costMicros: Number(row.cost_micros),
    }));
  },

  /** Event count for a user, for assertions that a call was actually billed. */
  async countFor(userId: string, executor: Executor = db): Promise<number> {
    const row = await executor
      .selectFrom('usage_events')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();

    return row.count;
  },
};
