const request = require('supertest');
const express = require('express');
const { createApp } = require('../../src/app');
const { createAdminRoutes } = require('../../src/routes/adminRoutes');

// ── Mock bot service ──────────────────────────────────────────────────────────

function makeMockBotService(overrides = {}) {
  return {
    health: jest.fn((req, res) =>
      res.status(200).json({ status: 'alive', timestamp: new Date().toISOString(), uptime: 0, service: 'test' })
    ),
    handleWhatsappWebhook: jest.fn((req, res) =>
      res.type('text/xml').send('<Response></Response>')
    ),
    handleNotifyUser: jest.fn((req, res) =>
      res.status(200).json({ ok: true, sid: 'SM-test' })
    ),
    handleListReceiptJobs: jest.fn((req, res) =>
      res.status(200).json({ ok: true, jobs: [] })
    ),
    handleListFailedReceiptJobs: jest.fn((req, res) =>
      res.status(200).json({ ok: true, jobs: [] })
    ),
    handleListDeadLetterReceiptJobs: jest.fn((req, res) =>
      res.status(200).json({ ok: true, jobs: [] })
    ),
    handleGetReceiptJob: jest.fn((req, res) =>
      res.status(404).json({ ok: false, error: 'Not found' })
    ),
    handleRetryReceiptJob: jest.fn((req, res) =>
      res.status(200).json({ ok: true })
    ),
    ...overrides,
  };
}

function buildWebhookRouter(botService) {
  const router = express.Router();
  router.get('/health', botService.health);
  router.post('/', botService.handleWhatsappWebhook);
  return router;
}

function buildApp(botServiceOverrides = {}) {
  const botService = makeMockBotService(botServiceOverrides);
  const webhookRouter = buildWebhookRouter(botService);
  const adminRouter = createAdminRoutes({ botService });
  return { app: createApp({ webhookRouter, adminRouter }), botService };
}

// ── Root ──────────────────────────────────────────────────────────────────────

describe('GET /', () => {
  test('returns app info with endpoint map', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: 'chatbot',
      endpoints: { webhook: '/webhook', admin: '/admin' },
    });
  });
});

// ── Webhook routes ────────────────────────────────────────────────────────────

describe('GET /webhook/health', () => {
  test('delegates to botService.health', async () => {
    const { app, botService } = buildApp();
    const res = await request(app).get('/webhook/health');
    expect(res.status).toBe(200);
    expect(botService.health).toHaveBeenCalled();
    expect(res.body).toMatchObject({ status: 'alive' });
  });
});

describe('POST /webhook', () => {
  test('delegates to botService.handleWhatsappWebhook', async () => {
    const { app, botService } = buildApp();
    const res = await request(app)
      .post('/webhook')
      .type('form')
      .send({ From: 'whatsapp:+6591234567', Body: 'hello', NumMedia: '0' });
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/xml/);
    expect(botService.handleWhatsappWebhook).toHaveBeenCalled();
  });

  test('passes request body to handler', async () => {
    const { app, botService } = buildApp();
    await request(app)
      .post('/webhook')
      .send({ From: 'whatsapp:+6591234567', Body: '1' });
    const [req] = botService.handleWhatsappWebhook.mock.calls[0];
    expect(req.body).toMatchObject({ From: 'whatsapp:+6591234567', Body: '1' });
  });
});

// ── Admin routes ──────────────────────────────────────────────────────────────

describe('GET /admin/receipt-jobs', () => {
  test('returns jobs list', async () => {
    const { app, botService } = buildApp({
      handleListReceiptJobs: jest.fn((req, res) =>
        res.status(200).json({ ok: true, jobs: [{ jobId: 'job-1' }] })
      ),
    });
    const res = await request(app).get('/admin/receipt-jobs');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, jobs: [{ jobId: 'job-1' }] });
    expect(botService.handleListReceiptJobs).toHaveBeenCalled();
  });

  test('accepts limit query param', async () => {
    const { app, botService } = buildApp();
    await request(app).get('/admin/receipt-jobs?limit=10');
    const [req] = botService.handleListReceiptJobs.mock.calls[0];
    expect(req.query.limit).toBe('10');
  });
});

describe('GET /admin/receipt-jobs/failed', () => {
  test('calls handleListFailedReceiptJobs', async () => {
    const { app, botService } = buildApp();
    const res = await request(app).get('/admin/receipt-jobs/failed');
    expect(res.status).toBe(200);
    expect(botService.handleListFailedReceiptJobs).toHaveBeenCalled();
  });
});

describe('GET /admin/receipt-jobs/dead-letter', () => {
  test('calls handleListDeadLetterReceiptJobs', async () => {
    const { app, botService } = buildApp();
    const res = await request(app).get('/admin/receipt-jobs/dead-letter');
    expect(res.status).toBe(200);
    expect(botService.handleListDeadLetterReceiptJobs).toHaveBeenCalled();
  });
});

describe('GET /admin/receipt-jobs/:jobId', () => {
  test('calls handleGetReceiptJob with jobId param', async () => {
    const { app, botService } = buildApp();
    const res = await request(app).get('/admin/receipt-jobs/job-abc-123');
    expect(res.status).toBe(404); // mock returns 404
    expect(botService.handleGetReceiptJob).toHaveBeenCalled();
    const [req] = botService.handleGetReceiptJob.mock.calls[0];
    expect(req.params.jobId).toBe('job-abc-123');
  });

  test('returns job when found', async () => {
    const { app } = buildApp({
      handleGetReceiptJob: jest.fn((req, res) =>
        res.status(200).json({ ok: true, job: { jobId: req.params.jobId, status: 'completed' } })
      ),
    });
    const res = await request(app).get('/admin/receipt-jobs/job-xyz');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, job: { jobId: 'job-xyz' } });
  });
});

describe('POST /admin/receipt-jobs/:jobId/retry', () => {
  test('calls handleRetryReceiptJob', async () => {
    const { app, botService } = buildApp();
    const res = await request(app).post('/admin/receipt-jobs/job-1/retry');
    expect(res.status).toBe(200);
    expect(botService.handleRetryReceiptJob).toHaveBeenCalled();
    const [req] = botService.handleRetryReceiptJob.mock.calls[0];
    expect(req.params.jobId).toBe('job-1');
  });
});

// ── Unknown routes ────────────────────────────────────────────────────────────

describe('Unknown routes', () => {
  test('GET /unknown returns 404', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/unknown-route');
    expect(res.status).toBe(404);
  });

  test('POST /unknown returns 404', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/unknown-route');
    expect(res.status).toBe(404);
  });
});

// ── Body parsing ──────────────────────────────────────────────────────────────

describe('Body parsing', () => {
  test('parses JSON body', async () => {
    const { app, botService } = buildApp();
    await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .send({ From: '+65', Body: 'test' });
    const [req] = botService.handleWhatsappWebhook.mock.calls[0];
    expect(req.body.From).toBe('+65');
  });

  test('parses URL-encoded body (Twilio default)', async () => {
    const { app, botService } = buildApp();
    await request(app)
      .post('/webhook')
      .type('form')
      .send('From=whatsapp%3A%2B6591234567&Body=hello');
    const [req] = botService.handleWhatsappWebhook.mock.calls[0];
    expect(req.body.From).toBe('whatsapp:+6591234567');
    expect(req.body.Body).toBe('hello');
  });
});

// ── App created without adminRouter ──────────────────────────────────────────

describe('createApp without adminRouter', () => {
  test('does not mount /admin routes', async () => {
    const webhookRouter = express.Router();
    webhookRouter.get('/health', (req, res) => res.json({ ok: true }));
    const app = createApp({ webhookRouter }); // no adminRouter
    const res = await request(app).get('/admin/receipt-jobs');
    expect(res.status).toBe(404);
  });
});
