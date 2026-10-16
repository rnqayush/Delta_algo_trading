const request = require('supertest');
const app = require('../src/app');

describe('Error handling', () => {
  it('returns 404 in the standard error shape for unknown routes', async () => {
    const response = await request(app).get('/api/this-does-not-exist');

    expect(response.status).toBe(404);
    expect(response.body.success).toBe(false);
    expect(typeof response.body.message).toBe('string');
  });

  it('rejects invalid JSON bodies with a 400', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": "broken"');

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
  });

  it('protects trading routes behind authentication', async () => {
    const response = await request(app).get('/api/orders');

    expect(response.status).toBe(401);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toMatch(/authentication/i);
  });

  it('rejects an invalid token', async () => {
    const response = await request(app)
      .get('/api/orders')
      .set('Authorization', 'Bearer not-a-real-token');

    expect(response.status).toBe(401);
    expect(response.body.success).toBe(false);
  });
});
