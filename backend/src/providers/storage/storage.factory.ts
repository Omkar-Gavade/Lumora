import { env } from '../../config/index.js';
import { LocalStorageProvider } from './local.storage.js';
import type { StorageProvider } from './storage-provider.interface.js';

/**
 * Resolves the configured backend — the one place a storage driver is chosen.
 *
 * The `switch` has no `default`, deliberately. `STORAGE_DRIVER` is a Zod enum,
 * so adding `'s3'` to it without adding an arm here is a compile error rather
 * than a silent fallback to local disk — which in a container means writing
 * documents to an ephemeral filesystem that vanishes on the next deploy.
 *
 * **There is no S3 stub class.** A class whose methods throw is a placeholder
 * that type-checks, satisfies the factory, and fails in production; the
 * preparation that actually helps is the interface — `put/get/delete/exists`
 * over an opaque key — which S3 satisfies natively. Adding the driver is one
 * file, one enum member, and one arm, and nothing above this line changes.
 */
export function createStorageProvider(): StorageProvider {
  switch (env.STORAGE_DRIVER) {
    case 'local':
      return new LocalStorageProvider(env.STORAGE_LOCAL_ROOT);
  }
}

export const storageProvider: StorageProvider = createStorageProvider();
