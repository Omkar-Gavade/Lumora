import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Locates this package's root by walking up from the current module until a
 * `package.json` appears.
 *
 * Anchored to `import.meta.url` rather than `process.cwd()` on purpose. The
 * working directory is whatever the operator happened to be in — `npm run`
 * sets it to the package root, a systemd unit or a container `CMD` very often
 * does not, and a path that resolves in development and not in production is
 * the worst kind of bug to find. The module's own location is a fact that does
 * not depend on how the process was launched.
 *
 * Resolved once at import; the filesystem layout cannot change under a running
 * process in any way that matters here.
 */
function findPackageRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));

  // `dirname('/')` is `/`, so the loop terminates at the filesystem root.
  for (;;) {
    if (existsSync(join(directory, 'package.json'))) return directory;
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error('Could not locate the backend package root: no package.json found.');
    }
    directory = parent;
  }
}

export const PACKAGE_ROOT = findPackageRoot();

/** Only the fields actually read. A manifest is not a config file. */
const packageManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
});

function readPackageManifest(): z.infer<typeof packageManifestSchema> {
  const raw = readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8');
  return packageManifestSchema.parse(JSON.parse(raw) as unknown);
}

export const PACKAGE_MANIFEST = readPackageManifest();
