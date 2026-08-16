import { join } from 'node:path';
import { PACKAGE_ROOT } from '../src/lib/paths.js';
import { userRepository } from '../src/repositories/user.repository.js';
import { passwordService } from '../src/services/auth/password.service.js';

/**
 * The evaluation corpus lives in `docs/`, one directory up from the backend
 * package. Those files are the project's own specification documents: real
 * prose, in version control, and readable by anyone checking whether a question
 * in `dataset.json` is answerable from them.
 */
export const REPO_DOCS_DIR = join(PACKAGE_ROOT, '..', 'docs');

/**
 * A dedicated account, not a developer's own.
 *
 * Retrieval is scoped per user at the repository layer and one Chroma
 * collection per user, so an evaluation account is also the cheapest honest way
 * to measure isolation: anything that leaks into these results came from
 * somewhere it should not have.
 */
export const EVAL_USER_EMAIL = 'eval@lumora.internal';

/**
 * Finds or creates the evaluation user.
 *
 * Idempotent, because `seed` and `run` are separate commands and either may be
 * the first to execute on a fresh database.
 */
export async function evalUserId(): Promise<string> {
  const existing = await userRepository.findByEmail(EVAL_USER_EMAIL);
  if (existing) return existing.id;

  const created = await userRepository.create({
    email: EVAL_USER_EMAIL,
    /*
      A random password that is never printed and never used — the harness
      calls services directly and never authenticates. Hashed anyway rather
      than stored as a placeholder string, so this row cannot become a usable
      account if the address is ever exposed.
    */
    passwordHash: await passwordService.hash(`eval-${crypto.randomUUID()}-${crypto.randomUUID()}`),
    displayName: 'Evaluation Harness',
  });

  return created.id;
}
