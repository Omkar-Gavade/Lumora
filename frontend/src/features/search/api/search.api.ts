import type { EvidenceBundleDto } from '@lumora/shared';
import { request } from '@/lib/api/client';

/**
 * Typed request functions for the retrieval endpoint
 * (docs/02-frontend.md §6, Tier 2).
 *
 * Pure async functions with no React dependency, so they are testable without
 * a renderer and callable from anywhere.
 */

export interface SearchParams {
  query: string;
  topK?: number;
  documentIds?: string[];
}

/**
 * Runs a retrieval and returns the evidence bundle.
 *
 * `POST`, not `GET`, even though both exist: the document filter is a list,
 * and a repeated query parameter is a worse contract than a JSON array. The
 * GET form is for curl and for a shareable URL, which is not what this call
 * site is.
 */
export async function search(params: SearchParams): Promise<EvidenceBundleDto> {
  return request<EvidenceBundleDto>('/search', {
    method: 'POST',
    // The client serializes and sets the content type; passing a string here
    // would send a JSON-encoded JSON string.
    body: {
      query: params.query,
      ...(params.topK === undefined ? {} : { topK: params.topK }),
      ...(params.documentIds === undefined || params.documentIds.length === 0
        ? {}
        : { filters: { documentIds: params.documentIds } }),
    },
  });
}
