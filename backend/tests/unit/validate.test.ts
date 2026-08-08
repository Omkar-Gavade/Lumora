import express, { type Express } from 'express';
import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loginRequestSchema, signupRequestSchema } from '@lumora/shared';
import { validate } from '../../src/api/middleware/validate.js';
import { errorHandler } from '../../src/api/middleware/error-handler.js';

function appValidating(schemas: Parameters<typeof validate>[0]): Express {
  const app = express();
  app.use(express.json());
  app.post('/echo', validate(schemas), (req, res) => {
    res.json({ body: req.body, query: req.query });
  });
  app.get('/echo', validate(schemas), (req, res) => {
    res.json({ query: req.query });
  });
  app.use(errorHandler);
  return app;
}

describe('validate middleware', () => {
  it('replaces the body with the parsed output', async () => {
    // Replacement is the point, not a detail: parsed output has unknown keys
    // stripped and values coerced, so a downstream service cannot read a
    // field the schema never approved.
    const response = await supertest(appValidating({ body: signupRequestSchema }))
      .post('/echo')
      .send({
        displayName: '  Omkar  ',
        email: '  MiXeD@Example.COM  ',
        password: 'Zt7qLmVx4Kdw',
      })
      .expect(200);

    expect(response.body.body).toEqual({
      displayName: 'Omkar',
      email: 'mixed@example.com',
      password: 'Zt7qLmVx4Kdw',
    });
  });

  it('strips unknown keys — the mass-assignment guard', async () => {
    const response = await supertest(appValidating({ body: signupRequestSchema }))
      .post('/echo')
      .send({
        displayName: 'A',
        email: 'a@b.com',
        password: 'Zt7qLmVx4Kdw',
        tokenVersion: 99,
        isAdmin: true,
      })
      .expect(200);

    expect(response.body.body).not.toHaveProperty('tokenVersion');
    expect(response.body.body).not.toHaveProperty('isAdmin');
  });

  it('applies schema defaults', async () => {
    const response = await supertest(appValidating({ body: loginRequestSchema }))
      .post('/echo')
      .send({ email: 'a@b.com', password: 'x' })
      .expect(200);

    expect(response.body.body.remember).toBe(true);
  });

  it('reports every failure at once, as 422 with field paths', async () => {
    const response = await supertest(appValidating({ body: signupRequestSchema }))
      .post('/echo')
      .send({ displayName: '', email: 'nope', password: 'short' })
      .expect(422);

    expect(response.body.error.code).toBe('VALIDATION_ERROR');

    const paths = response.body.error.details.fields.map((field: { path: string }) => field.path);
    // All three, not just the first — a form that fixes one error at a time
    // takes three round trips to submit.
    expect(new Set(paths)).toEqual(new Set(['displayName', 'email', 'password']));
  });

  it('reports nested paths in dotted form the frontend can map to inputs', async () => {
    const schema = z.object({ profile: z.object({ name: z.string().min(1) }) });

    const response = await supertest(appValidating({ body: schema }))
      .post('/echo')
      .send({ profile: { name: '' } })
      .expect(422);

    expect(response.body.error.details.fields[0].path).toBe('profile.name');
  });

  it('validates and replaces the query string', async () => {
    // Express 5 exposes `query` as a getter on the prototype, so a plain
    // assignment throws; the middleware defines an own property to shadow it.
    const schema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) });

    const response = await supertest(appValidating({ query: schema }))
      .get('/echo?limit=25')
      .expect(200);

    expect(response.body.query).toEqual({ limit: 25 });
  });

  it('rejects an invalid query with 422', async () => {
    const schema = z.object({ limit: z.coerce.number().int().max(50) });

    const response = await supertest(appValidating({ query: schema })).get('/echo?limit=999');

    expect(response.status).toBe(422);
    expect(response.body.error.details.fields[0].path).toBe('limit');
  });

  it('passes a valid request straight through', async () => {
    await supertest(appValidating({ body: loginRequestSchema }))
      .post('/echo')
      .send({ email: 'a@b.com', password: 'x', remember: false })
      .expect(200);
  });
});
