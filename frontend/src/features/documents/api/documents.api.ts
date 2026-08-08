import type {
  DocumentDto,
  DocumentListDto,
  ListDocumentsQuery,
  StorageUsageDto,
  UploadResultDto,
} from '@lumora/shared';
import { getAccessToken, request } from '@/lib/api/client';
import { env } from '@/app/config/env';
import { ApiError, toApiError } from '@/lib/api/errors';

/**
 * Typed request functions, one per endpoint (docs/02-frontend.md §6, Tier 2).
 *
 * Pure async functions with no React dependency, so they are testable without
 * a renderer and callable from anywhere.
 */

export async function listDocuments(
  filters: Partial<ListDocumentsQuery> = {},
): Promise<DocumentListDto> {
  const params = new URLSearchParams();
  if (filters.cursor) params.set('cursor', filters.cursor);
  if (filters.status) params.set('status', filters.status);
  if (filters.limit) params.set('limit', String(filters.limit));

  const query = params.toString();
  return request<DocumentListDto>(`/documents${query ? `?${query}` : ''}`);
}

export async function getDocument(id: string): Promise<DocumentDto> {
  return request<DocumentDto>(`/documents/${id}`);
}

export async function deleteDocument(id: string): Promise<void> {
  await request<undefined>(`/documents/${id}`, { method: 'DELETE' });
}

export async function getStorageUsage(): Promise<StorageUsageDto> {
  return request<StorageUsageDto>('/documents/usage');
}

/**
 * Uploads files as multipart.
 *
 * Written against `fetch` directly rather than through `request()`, for one
 * reason: the shared client sets `Content-Type: application/json`, and a
 * multipart body needs the *browser* to set that header with the boundary it
 * generated. Setting it by hand produces a body the server cannot parse, and
 * the failure reads as a malformed request rather than a missing boundary.
 *
 * Everything else the client provides is reproduced — bearer token, credential
 * mode, and the same `ApiError` normalization — so callers handle failures
 * identically to every other endpoint.
 */
export async function uploadDocuments(files: File[]): Promise<UploadResultDto> {
  const body = new FormData();
  for (const file of files) body.append('files', file);

  const headers = new Headers();
  const token = getAccessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(`${env.VITE_API_URL}/api/v1/documents`, {
      method: 'POST',
      headers,
      body,
      credentials: 'include',
      /*
        No timeout, deliberately. The JSON client aborts at 15s, which is
        correct for a request whose response is a few hundred bytes and wrong
        for one carrying 25 MB — aborting a nearly complete upload on a slow
        connection is worse than waiting for it.
      */
    });
  } catch {
    throw ApiError.network();
  }

  if (!response.ok) throw await toApiError(response);

  return (await response.json()) as UploadResultDto;
}
