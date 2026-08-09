import { env } from '../../config/index.js';
import { FakeLLMProvider } from './fake.provider.js';
import { GeminiProvider } from './gemini.provider.js';
import type { LLMProvider } from './llm-provider.interface.js';
import { OpenAiProvider } from './openai.provider.js';

/**
 * Resolves the configured chat provider — the one place a vendor is chosen
 * (docs/05-rag-and-chat.md §6: "Chosen at boot by a factory from config").
 *
 * No `default` arm. `LLM_PROVIDER` is a Zod enum, so adding a vendor without
 * adding a case is a compile error rather than a silent fallback to the fake —
 * which would answer every question with canned text while looking healthy.
 */
export function createLLMProvider(): LLMProvider {
  switch (env.LLM_PROVIDER) {
    case 'fake':
      return new FakeLLMProvider({
        model: env.LLM_MODEL,
        contextWindow: env.LLM_CONTEXT_WINDOW,
      });

    case 'gemini':
      return new GeminiProvider(
        env.LLM_MODEL,
        env.LLM_CONTEXT_WINDOW,
        keyFor('gemini', env.GEMINI_API_KEY),
      );

    case 'openai':
      return new OpenAiProvider(
        env.LLM_MODEL,
        env.LLM_CONTEXT_WINDOW,
        keyFor('openai', env.OPENAI_API_KEY),
      );
  }
}

/**
 * `LLM_API_KEY` first, then the documented per-provider key.
 *
 * The override exists so a deployment can point chat at a different account
 * from embeddings; the fallback exists because docs/03-backend.md §5 names the
 * per-provider variables and M4b already reads them.
 */
function keyFor(provider: string, providerKey: string | undefined): string {
  const key = env.LLM_API_KEY ?? providerKey;

  if (key === undefined) {
    // Unreachable: the config cross-check refuses to boot without one. Throwing
    // names the invariant that broke rather than surfacing as `undefined` in an
    // Authorization header, which presents as a 401 and sends whoever is
    // debugging it to check the wrong system.
    throw new Error(
      `no API key for LLM_PROVIDER=${provider} — set LLM_API_KEY or the per-provider key; the cross-check in env.ts should have prevented startup`,
    );
  }

  return key;
}

export const llmProvider: LLMProvider = createLLMProvider();
