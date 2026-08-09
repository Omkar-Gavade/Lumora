import { logger } from '../../lib/logger.js';

/**
 * Tracks in-flight generations so they can be cancelled by id.
 *
 * docs/05-rag-and-chat.md §7: "open SSE, register the AbortController in an
 * in-process registry keyed by conversation" — and the stop endpoint "aborts
 * the controller".
 *
 * **In-process, and that is a stated Phase 1 limit rather than an oversight.**
 * docs/06-roadmap.md R7 names it directly: "the in-process abort registry
 * means a stop request must reach the same process that owns the stream". With
 * one node that is always true. With two, a stop request load-balanced to the
 * wrong instance finds nothing to abort — and the fix is the same shape as the
 * rate limiter's: this interface, backed by a shared channel.
 *
 * Behind an interface for exactly that reason (§8, "each is behind an
 * interface or isolated in a module").
 */
export interface AbortRegistry {
  /** Registers a generation. Returns a function that unregisters it. */
  register(conversationId: string, controller: AbortController): () => void;
  /** Aborts a generation. Returns whether one was running. */
  abort(conversationId: string): boolean;
  has(conversationId: string): boolean;
  readonly size: number;
}

class InProcessAbortRegistry implements AbortRegistry {
  private readonly controllers = new Map<string, AbortController>();

  register(conversationId: string, controller: AbortController): () => void {
    /*
      One generation per conversation, and a second registration aborts the
      first.

      A user who sends a second message while the first is still generating has
      abandoned the first answer — it will never be read, and letting both run
      bills for two completions to display one. The placeholder for the
      abandoned turn is still finalized as `stopped` by its own handler, so the
      thread stays coherent.
    */
    const existing = this.controllers.get(conversationId);
    if (existing !== undefined) {
      logger.info({ conversationId }, 'Superseding an in-flight generation');
      existing.abort();
    }

    this.controllers.set(conversationId, controller);

    return () => {
      // Only if it is still *this* controller. Unregistering unconditionally
      // would let a finishing stream delete the entry belonging to the
      // generation that superseded it, leaving the new one unstoppable.
      if (this.controllers.get(conversationId) === controller) {
        this.controllers.delete(conversationId);
      }
    };
  }

  abort(conversationId: string): boolean {
    const controller = this.controllers.get(conversationId);
    if (controller === undefined) return false;

    controller.abort();
    this.controllers.delete(conversationId);
    return true;
  }

  has(conversationId: string): boolean {
    return this.controllers.has(conversationId);
  }

  get size(): number {
    return this.controllers.size;
  }

  /** See `resetAbortRegistryForTests`. */
  clear(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }
}

const registry = new InProcessAbortRegistry();

export const abortRegistry: AbortRegistry = registry;

/**
 * Test seam: aborts and drops every registration.
 *
 * Deliberately **not** on the `AbortRegistry` interface — nothing in
 * production has any business cancelling every user's generation at once, and
 * putting it on the interface would make that a one-line mistake. The same
 * reasoning as `resetRateLimitsForTests`.
 */
export function resetAbortRegistryForTests(): void {
  registry.clear();
}
