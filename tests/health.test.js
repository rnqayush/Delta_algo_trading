const request = require('supertest');
const app = require('../src/app');

describe('GET /api/health', () => {
  it('reports that the trading backend is running', async () => {
    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.message).toBe('Trading backend is running');
    expect(response.body.data.tradingMode).toBe('paper');
  });

  it('never exposes the Delta API keys', async () => {
    const response = await request(app).get('/api/health');

    expect(JSON.stringify(response.body)).not.toContain('secret');
    expect(response.body.data.deltaConfigured).toBeDefined();
  });
});
