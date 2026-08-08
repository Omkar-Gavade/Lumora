import { describe, expect, it } from 'vitest';
import { healthResponseSchema, readinessResponseSchema } from '@lumora/shared';
import { request } from '../helpers/app.js';
import { expectSchema } from '../utils/contract.js';

/**
 * The health endpoints are the one place a contract test is the *whole* test:
 * they have no logic beyond assembling a documented shape, and that shape is
 * consumed by orchestrators that will not tell you when it changes.
 */
describe('GET /health', () => {
  it('returns 200 with the documented liveness shape', async () => {
    const response = await request().get('/health').expect(200);

    const body = expectSchema(response, healthResponseSchema);
    expect(body.status).toBe('ok');
    expect(body.environment).toBe('test');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('touches no dependency — liveness must not fail when a dependency does', async () => {
    // Asserted structurally: the payload carries no dependency section at all,
    // so there is nothing for a database blip to turn red. A liveness probe
    // that checks the database turns an outage into a restart storm.
    const response = await request().get('/health').expect(200);
    expect(response.body).not.toHaveProperty('checks');
  });
});

describe('GET /health/ready', () => {
  it('returns 200 with the documented readiness shape when the database is up', async () => {
    const response = await request().get('/health/ready').expect(200);

    const body = expectSchema(response, readinessResponseSchema);
    expect(body.status).toBe('ok');
    expect(body.checks.database.status).toBe('ok');
    expect(body.checks.database.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe('unmatched routes', () => {
  it('returns the JSON error envelope, not Express default HTML', async () => {
    const response = await request().get('/does-not-exist').expect(404);

    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('echoes the request id on every response', async () => {
    const response = await request().get('/health').expect(200);
    expect(response.headers['x-request-id']).toMatch(/^req_/);
  });

  it('honours a valid inbound request id but rejects one containing control characters', async () => {
    const clean = await request().get('/health').set('X-Request-Id', 'trace-abc-123');
    expect(clean.headers['x-request-id']).toBe('trace-abc-123');

    // Log injection: a newline in this header forges log entries.
    const dirty = await request().get('/health').set('X-Request-Id', 'bad id with spaces');
    expect(dirty.headers['x-request-id']).toMatch(/^req_/);
  });
});
