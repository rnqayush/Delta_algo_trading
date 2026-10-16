const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

const app = require('../src/app');

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await mongoose.connection.db.dropDatabase();
});

const testUser = {
  name: 'Test Trader',
  email: 'trader@example.com',
  password: 'secret123',
};

async function registerUser(user = testUser) {
  return request(app).post('/api/auth/register').send(user);
}

describe('Authentication', () => {
  it('registers a user and returns a token', async () => {
    const response = await registerUser();

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.data.token).toEqual(expect.any(String));
    expect(response.body.data.user.email).toBe(testUser.email);
  });

  it('never returns the password', async () => {
    const response = await registerUser();

    expect(response.body.data.user.password).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain(testUser.password);
  });

  it('rejects a duplicate email', async () => {
    await registerUser();
    const response = await registerUser();

    expect(response.status).toBe(409);
    expect(response.body.success).toBe(false);
  });

  it('rejects a short password', async () => {
    const response = await registerUser({ ...testUser, password: '123' });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
  });

  it('logs in with valid credentials', async () => {
    await registerUser();

    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: testUser.email, password: testUser.password });

    expect(response.status).toBe(200);
    expect(response.body.data.token).toEqual(expect.any(String));
  });

  it('rejects a wrong password', async () => {
    await registerUser();

    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: testUser.email, password: 'wrong-password' });

    expect(response.status).toBe(401);
    expect(response.body.success).toBe(false);
  });

  it('returns the current user for a valid token', async () => {
    const registered = await registerUser();
    const token = registered.body.data.token;

    const response = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.data.user.email).toBe(testUser.email);
  });

  it('rejects /me without a token', async () => {
    const response = await request(app).get('/api/auth/me');

    expect(response.status).toBe(401);
  });
});
