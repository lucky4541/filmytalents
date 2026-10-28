import { describe, expect, it } from 'vitest';
import { api } from './helpers';

describe('core', () => {
  it('health check reports database ok', async () => {
    const r = await api().get('/health');
    expect(r.status).toBe(200);
    expect(r.body.db).toBe('ok');
  });
  it('unknown endpoint returns 404 json', async () => {
    const r = await api().get('/api/v1/nope');
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('NOT_FOUND');
  });
  it('bad json returns 400', async () => {
    const r = await api().post('/api/v1/anything').set('content-type', 'application/json').send('{bad');
    expect(r.status).toBe(400);
  });
});
