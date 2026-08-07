import { cp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Copies non-TypeScript assets into the build output.
 *
 * `tsc` emits only what it compiles, so the `.sql` migration files never reach
 * `dist/` on their own — and the runner resolves them relative to its own
 * module, which after a build is `dist/db/migrate.js`. Without this step
 * `npm start` works and `npm run migrate` against the built output fails with
 * ENOENT on a directory that plainly exists in `src/`.
 *
 * Node's own `fs.cp` rather than a shell `cp -r`, so the build does not depend
 * on which shell is running it.
 */
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

await cp(join(packageRoot, 'src/db/migrations'), join(packageRoot, 'dist/db/migrations'), {
  recursive: true,
});
