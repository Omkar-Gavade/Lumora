import type TestAgent from 'supertest/lib/agent.js';
import type { Test } from 'supertest';
import { API_PREFIX, request } from './app.js';

/**
 * Attaches a bearer token to a request.
 *
 * Curried so a test reads as the sentence it is asserting:
 *
 *   await authenticatedRequest(token).get('/auth/me').expect(200);
 *
 * Paths are given without the `/api/v1` prefix — every call site would
 * otherwise repeat it, and the version would be pinned in dozens of files.
 */
export function authenticatedRequest(accessToken: string): {
  get: (path: string) => Test;
  post: (path: string) => Test;
  patch: (path: string) => Test;
  delete: (path: string) => Test;
} {
  const withAuth = (test: Test): Test => test.set('Authorization', `Bearer ${accessToken}`);

  return {
    get: (path) => withAuth(request().get(`${API_PREFIX}${path}`)),
    post: (path) => withAuth(request().post(`${API_PREFIX}${path}`)),
    patch: (path) => withAuth(request().patch(`${API_PREFIX}${path}`)),
    delete: (path) => withAuth(request().delete(`${API_PREFIX}${path}`)),
  };
}

/** The same, without credentials — for asserting that a route is guarded. */
export function anonymousRequest(): {
  get: (path: string) => Test;
  post: (path: string) => Test;
} {
  return {
    get: (path) => request().get(`${API_PREFIX}${path}`),
    post: (path) => request().post(`${API_PREFIX}${path}`),
  };
}

/**
 * A cookie-persisting agent already holding a session.
 *
 * Required for rotation tests: refresh replaces the cookie every call, and an
 * agent that does not store it would keep presenting the original — which is a
 * replay, and would trip reuse detection rather than testing rotation.
 */
export function sessionAgent(agentInstance: TestAgent): {
  refresh: () => Test;
  logout: () => Test;
} {
  return {
    refresh: () => agentInstance.post(`${API_PREFIX}/auth/refresh`),
    logout: () => agentInstance.post(`${API_PREFIX}/auth/logout`),
  };
}
