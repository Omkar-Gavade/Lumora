import type { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { StorageError, type PutOptions, type StorageProvider } from './storage-provider.interface.js';

export interface S3StorageOptions {
  bucket: string;
  region: string;
  /** Set only for S3-compatible servers (MinIO in tests). Never in production. */
  endpoint?: string | undefined;
  /** Required by MinIO, harmful against real S3 where virtual-host style is standard. */
  forcePathStyle?: boolean | undefined;
  /**
   * Server-side encryption requested per object. `AES256` (SSE-S3) is the
   * production value and the default.
   *
   * Overridable to `none` only because S3-compatible servers reject the header
   * unless a KMS is configured — MinIO answers `NotImplemented`. Real S3
   * applies SSE-S3 with no key management at all, so there is never a reason
   * to disable it there, and the production config rules refuse to.
   */
  serverSideEncryption?: 'AES256' | 'none' | undefined;
  /**
   * Explicit credentials, for S3-compatible services that are not AWS.
   *
   * Omit for real S3, where the SDK's default provider chain resolves an ECS
   * task role and no long-lived key exists. Supabase Storage issues its own
   * access key pair which has nothing to do with AWS, so passing it here keeps
   * it out of `AWS_*` process variables where it would be mistaken for one.
   */
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
}

/**
 * Object storage for original uploads (docs/08-production-architecture.md §5).
 *
 * The local filesystem cannot be the production mechanism for one reason: the
 * container is ephemeral. A task replacement, a scale event, or a deploy takes
 * the disk with it, and the user's documents are the one thing in this product
 * that cannot be regenerated — chunks can be re-derived from an original, and
 * vectors from chunks, but nothing re-derives the original.
 *
 * **No credentials are configured here.** The SDK's default provider chain
 * resolves them, which in production means an ECS task role and in development
 * means whatever the developer already has. Passing an access key through the
 * application config would put a long-lived credential in the environment of
 * every process that loads `env.ts`, and rotating it would become a deploy.
 *
 * The bucket is private and stays private. Nothing here generates a public URL
 * or a presigned one: reads go through the API, which has already checked
 * ownership. That costs a proxied byte stream and buys an authorization
 * decision that cannot be replayed by anyone who copies a link.
 */
export class S3StorageProvider implements StorageProvider {
  readonly name = 's3';

  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly encryption: 'AES256' | 'none';

  constructor(options: S3StorageOptions) {
    this.bucket = options.bucket;
    this.encryption = options.serverSideEncryption ?? 'AES256';
    /*
      Credentials are passed only when both halves are present. A partial pair
      would otherwise silently disable the default provider chain and fail with
      a signature error rather than a configuration one.
    */
    const explicit =
      options.accessKeyId !== undefined && options.secretAccessKey !== undefined
        ? {
            credentials: {
              accessKeyId: options.accessKeyId,
              secretAccessKey: options.secretAccessKey,
            },
          }
        : {};

    this.client = new S3Client({
      region: options.region,
      ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
      ...(options.forcePathStyle === undefined ? {} : { forcePathStyle: options.forcePathStyle }),
      ...explicit,
    });
  }

  async put(key: string, bytes: Buffer, options: PutOptions): Promise<void> {
    assertSafeKey(key, 'put');

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: bytes,
          ContentType: options.contentType,
          /*
            Encryption at rest, requested explicitly rather than relying on the
            bucket default. A bucket created without default encryption, or one
            whose policy is later relaxed, would otherwise store documents in
            the clear and nothing in this code would say so. Terraform sets the
            bucket default as well; this is the belt to that pair of braces.
          */
          ...(this.encryption === 'none' ? {} : { ServerSideEncryption: this.encryption }),
        }),
      );
    } catch (error) {
      throw new StorageError('put', key, error);
    }
  }

  async get(key: string): Promise<Readable> {
    assertSafeKey(key, 'get');

    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );

      if (response.Body === undefined) {
        throw new Error('S3 returned no body');
      }

      // The Node runtime always yields a Readable here; the union in the types
      // covers the browser build of the SDK, which this process is not.
      return response.Body as Readable;
    } catch (error) {
      throw new StorageError('get', key, error);
    }
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key, 'delete');

    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      throw new StorageError('delete', key, error);
    }
  }

  /**
   * Whether an object exists.
   *
   * A 404 is an answer, not a failure — `exists` returning `false` is the
   * point. Anything else (403 from a broken policy, a network fault) is a real
   * error and must not be flattened into "no", which would present a
   * permissions bug as a missing document.
   */
  async exists(key: string): Promise<boolean> {
    assertSafeKey(key, 'exists');

    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw new StorageError('exists', key, error);
    }
  }
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;

  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  const name = (error as { name?: string }).name;

  return status === 404 || name === 'NotFound' || name === 'NoSuchKey';
}

/**
 * Rejects keys that could escape their prefix.
 *
 * S3 has no directories, so `..` is not traversal in the filesystem sense —
 * but the keys here are built from a template (`users/{userId}/documents/…`)
 * and every guarantee about tenant separation rests on a key staying inside
 * its user's prefix. A key containing `..` or a leading slash is either a bug
 * in that construction or an attempt to reach another prefix, and both should
 * stop here rather than at a bucket policy that may not exist.
 *
 * `LocalStorageProvider` performs the equivalent check by resolving against
 * its root; this is the same guarantee expressed for a store that has no
 * filesystem to resolve against.
 */
function assertSafeKey(key: string, operation: 'put' | 'get' | 'delete' | 'exists'): void {
  const unsafe =
    key.length === 0 ||
    key.startsWith('/') ||
    key.includes('..') ||
    key.includes('\0') ||
    // A backslash is a legal S3 character and never appears in a key this
    // application builds, so its presence means the key came from somewhere it
    // should not have.
    key.includes('\\');

  if (unsafe) {
    throw new StorageError(operation, key, new Error('unsafe object key'));
  }
}
