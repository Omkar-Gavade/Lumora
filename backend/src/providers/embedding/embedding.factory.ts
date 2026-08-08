import { env } from '../../config/index.js';
import type { EmbeddingProvider } from './embedding-provider.interface.js';
import { FakeEmbeddingProvider } from './fake-embedding.provider.js';
import { GeminiEmbeddingProvider } from './gemini-embedding.provider.js';
import { OpenAiEmbeddingProvider } from './openai-embedding.provider.js';

/**
 * Resolves the configured embedding provider — the one place a vendor is
 * chosen (docs/05-rag-and-chat.md §6: "Chosen at boot by a factory from
 * config").
 *
 * The `switch` has no `default`. `EMBEDDING_PROVIDER` is a Zod enum, so adding
 * a vendor without adding an arm is a compile error rather than a silent
 * fallback to the fake — which would index a whole corpus with meaningless
 * vectors and look completely healthy while doing it.
 *
 * The API keys are asserted non-null by the config's `superRefine`, which
 * refuses to boot a `gemini` selection without `GEMINI_API_KEY`. The
 * non-null assertions below are that guarantee restated, not a hope.
 */
export function createEmbeddingProvider(): EmbeddingProvider {
  switch (env.EMBEDDING_PROVIDER) {
    case 'fake':
      return new FakeEmbeddingProvider({
        model: env.EMBEDDING_MODEL,
        dimensions: env.EMBEDDING_DIMENSIONS,
      });

    case 'gemini':
      return new GeminiEmbeddingProvider(
        env.EMBEDDING_MODEL,
        env.EMBEDDING_DIMENSIONS,
        env.GEMINI_API_KEY ?? unreachable('GEMINI_API_KEY'),
      );

    case 'openai':
      return new OpenAiEmbeddingProvider(
        env.EMBEDDING_MODEL,
        env.EMBEDDING_DIMENSIONS,
        env.OPENAI_API_KEY ?? unreachable('OPENAI_API_KEY'),
      );
  }
}

/**
 * Reached only if the config cross-check that guarantees this key is missing.
 *
 * Throwing beats `!` because the message names the invariant that broke rather
 * than surfacing as `undefined` inside an Authorization header, where it
 * presents as a 401 from the provider and sends whoever is debugging it to
 * check the wrong system.
 */
function unreachable(variable: string): never {
  throw new Error(
    `${variable} is unset but the provider requiring it was selected — the config cross-check in env.ts should have prevented startup`,
  );
}

export const embeddingProvider: EmbeddingProvider = createEmbeddingProvider();
