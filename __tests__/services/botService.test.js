jest.mock('twilio', () => {
  const mockTwimlInstance = {
    message: jest.fn().mockReturnThis(),
    toString: jest.fn().mockReturnValue('<Response><Message>test</Message></Response>'),
  };
  const MessagingResponse = jest.fn(() => mockTwimlInstance);
  return { twiml: { MessagingResponse } };
});

jest.mock('pdf2pic', () => ({
  fromBuffer: jest.fn(),
}));

jest.mock('html-to-text', () => ({
  htmlToText: jest.fn((text) => text),
}));

jest.mock('../../src/services/queueService', () => ({
  enqueueReceiptJob: jest.fn(),
  retryReceiptQueueJob: jest.fn(),
}));

const { createBotService } = require('../../src/services/botService');
const { enqueueReceiptJob, retryReceiptQueueJob } = require('../../src/services/queueService');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeHelpers(overrides = {}) {
  return {
    logToFile: jest.fn(),
    getChatState: jest.fn().mockResolvedValue({}),
    updateChatState: jest.fn().mockResolvedValue({}),
    checkOrCreateUserProfile: jest.fn().mockResolvedValue({ profileId: 42 }),
    getLoyaltyPoints: jest.fn().mockResolvedValue({ points: 100, message: '100 points' }),
    fetchImageFromTwilio: jest.fn(),
    getPromotions: jest.fn().mockResolvedValue({ message: 'No promotions' }),
    getDefaultMessage: jest.fn().mockResolvedValue('Welcome! Reply 1 to upload a receipt.'),
    receiptJobService: {
      createQueuedJob: jest.fn().mockResolvedValue({ jobId: 'job-1' }),
      getJob: jest.fn().mockResolvedValue(null),
      markRetryQueued: jest.fn().mockResolvedValue({}),
      listRecentJobs: jest.fn().mockResolvedValue([]),
      listFailedJobs: jest.fn().mockResolvedValue([]),
      listDeadLetterJobs: jest.fn().mockResolvedValue([]),
    },
    ...overrides,
  };
}

function makeTwilioClient() {
  return {
    messages: {
      create: jest.fn().mockResolvedValue({ sid: 'SM-notify-123' }),
    },
  };
}

function makeRateLimiter(overrides = {}) {
  return {
    checkRateLimit: jest.fn().mockResolvedValue({ allowed: true, warning: null }),
    recordMessageSent: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function makeReqRes(body = {}, headers = {}, params = {}, query = {}) {
  const res = {
    headersSent: false,
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    type: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  };
  const req = { body, headers, params, query };
  return { req, res };
}

// ── Validation ────────────────────────────────────────────────────────────────

describe('createBotService — validation', () => {
  test('throws when helpers is missing', () => {
    expect(() =>
      createBotService({ twilioClient: makeTwilioClient(), rateLimiter: makeRateLimiter() })
    ).toThrow('missing helpers');
  });

  test('throws when twilioClient is missing', () => {
    expect(() =>
      createBotService({ helpers: makeHelpers(), rateLimiter: makeRateLimiter() })
    ).toThrow('missing twilioClient');
  });

  test('throws when rateLimiter is missing', () => {
    expect(() =>
      createBotService({ helpers: makeHelpers(), twilioClient: makeTwilioClient() })
    ).toThrow('missing rateLimiter');
  });

  test('throws when a required helper function is missing', () => {
    const helpers = makeHelpers();
    delete helpers.logToFile;
    expect(() =>
      createBotService({ helpers, twilioClient: makeTwilioClient(), rateLimiter: makeRateLimiter() })
    ).toThrow('helpers.logToFile is missing');
  });

  test('throws when rateLimiter.checkRateLimit is not a function', () => {
    expect(() =>
      createBotService({
        helpers: makeHelpers(),
        twilioClient: makeTwilioClient(),
        rateLimiter: { checkRateLimit: 'not-a-fn', recordMessageSent: jest.fn() },
      })
    ).toThrow('rateLimiter.checkRateLimit is missing');
  });

  test('creates service successfully with valid dependencies', () => {
    expect(() =>
      createBotService({ helpers: makeHelpers(), twilioClient: makeTwilioClient(), rateLimiter: makeRateLimiter() })
    ).not.toThrow();
  });
});

// ── health ────────────────────────────────────────────────────────────────────

describe('health', () => {
  test('returns 200 with status=alive', () => {
    const service = createBotService({
      helpers: makeHelpers(), twilioClient: makeTwilioClient(), rateLimiter: makeRateLimiter(),
    });
    const { req, res } = makeReqRes();
    service.health(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'alive', service: 'WhatsApp Receipt Bot' })
    );
  });
});

// ── handleWhatsappWebhook ─────────────────────────────────────────────────────

describe('handleWhatsappWebhook', () => {
  let service, helpers, rateLimiter;

  beforeEach(() => {
    jest.clearAllMocks();
    helpers = makeHelpers();
    rateLimiter = makeRateLimiter();
    service = createBotService({ helpers, twilioClient: makeTwilioClient(), rateLimiter });
  });

  test('returns empty TwiML when From is missing', async () => {
    const { req, res } = makeReqRes({ From: '', Body: 'hello' });
    await service.handleWhatsappWebhook(req, res);
    expect(res.type).toHaveBeenCalledWith('text/xml');
    expect(res.send).toHaveBeenCalledWith('');
  });

  test('returns error TwiML when profile creation throws', async () => {
    helpers.checkOrCreateUserProfile.mockRejectedValue(new Error('WP down'));
    const { req, res } = makeReqRes({ From: 'whatsapp:+6591234567', Body: 'hi' });
    await service.handleWhatsappWebhook(req, res);
    expect(res.type).toHaveBeenCalledWith('text/xml');
    expect(res.send).toHaveBeenCalled(); // TwiML reply sent (mock doesn't propagate message content)
  });

  test('returns error TwiML when profileId is null', async () => {
    helpers.checkOrCreateUserProfile.mockResolvedValue({ profileId: null });
    const { req, res } = makeReqRes({ From: 'whatsapp:+6591234567', Body: 'hi' });
    await service.handleWhatsappWebhook(req, res);
    expect(res.type).toHaveBeenCalledWith('text/xml');
  });

  test('returns empty TwiML and drops message when rate limit reached (no warning)', async () => {
    rateLimiter.checkRateLimit.mockResolvedValue({ allowed: false, warning: null });
    const { req, res } = makeReqRes({ From: 'whatsapp:+6591234567', Body: 'hello', NumMedia: '0' });
    await service.handleWhatsappWebhook(req, res);
    expect(res.send).toHaveBeenCalledWith('');
  });

  test('sends warning TwiML when rate limit has a warning message', async () => {
    rateLimiter.checkRateLimit.mockResolvedValue({ allowed: false, warning: 'Daily limit reached' });
    const { req, res } = makeReqRes({ From: 'whatsapp:+6591234567', Body: 'hi', NumMedia: '0' });
    await service.handleWhatsappWebhook(req, res);
    expect(res.type).toHaveBeenCalledWith('text/xml');
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining('Response'));
  });

  test('responds to "help" by calling getDefaultMessage', async () => {
    const { req, res } = makeReqRes({ From: 'whatsapp:+6591234567', Body: 'help', NumMedia: '0' });
    await service.handleWhatsappWebhook(req, res);
    expect(helpers.getDefaultMessage).toHaveBeenCalled();
    expect(rateLimiter.recordMessageSent).toHaveBeenCalledWith(42);
  });

  test('responds to "HELP" (case-insensitive)', async () => {
    const { req, res } = makeReqRes({ From: 'whatsapp:+6591234567', Body: 'HELP', NumMedia: '0' });
    await service.handleWhatsappWebhook(req, res);
    expect(helpers.getDefaultMessage).toHaveBeenCalled();
  });

  test('responds to "stop" by clearing state and confirming exit', async () => {
    const { req, res } = makeReqRes({ From: 'whatsapp:+6591234567', Body: 'stop', NumMedia: '0' });
    await service.handleWhatsappWebhook(req, res);
    expect(helpers.updateChatState).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ expectingImage: false, receiptFiles: [] })
    );
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining('Response'));
  });

  test('responds to "1" by setting expectingImage=true', async () => {
    const { req, res } = makeReqRes({ From: 'whatsapp:+6591234567', Body: '1', NumMedia: '0' });
    await service.handleWhatsappWebhook(req, res);
    expect(helpers.updateChatState).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ expectingImage: true, receiptFiles: [] })
    );
  });

  test('responds to "upload a receipt" text', async () => {
    const { req, res } = makeReqRes({ From: 'whatsapp:+6591234567', Body: 'upload a receipt', NumMedia: '0' });
    await service.handleWhatsappWebhook(req, res);
    expect(helpers.updateChatState).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ expectingImage: true })
    );
  });

  test('responds to "2" by calling getLoyaltyPoints', async () => {
    const { req, res } = makeReqRes({ From: 'whatsapp:+6591234567', Body: '2', NumMedia: '0' });
    await service.handleWhatsappWebhook(req, res);
    expect(helpers.getLoyaltyPoints).toHaveBeenCalledWith(42);
  });

  test('responds to "points" keyword', async () => {
    const { req, res } = makeReqRes({ From: 'whatsapp:+6591234567', Body: 'my points', NumMedia: '0' });
    await service.handleWhatsappWebhook(req, res);
    expect(helpers.getLoyaltyPoints).toHaveBeenCalled();
  });

  test('responds to "4" by calling getPromotions', async () => {
    const { req, res } = makeReqRes({ From: 'whatsapp:+6591234567', Body: '4', NumMedia: '0' });
    await service.handleWhatsappWebhook(req, res);
    expect(helpers.getPromotions).toHaveBeenCalled();
  });

  test('falls back to default message for unrecognised text', async () => {
    const { req, res } = makeReqRes({ From: 'whatsapp:+6591234567', Body: 'random text', NumMedia: '0' });
    await service.handleWhatsappWebhook(req, res);
    expect(helpers.getDefaultMessage).toHaveBeenCalled();
  });

  test('collects image when state.expectingImage is true', async () => {
    helpers.getChatState.mockResolvedValue({ expectingImage: true, receiptFiles: [] });
    const { req, res } = makeReqRes({
      From: 'whatsapp:+6591234567',
      Body: '',
      NumMedia: '1',
      MediaUrl0: 'http://media.twilio.com/img.jpg',
      MediaContentType0: 'image/jpeg',
    });
    await service.handleWhatsappWebhook(req, res);
    expect(helpers.updateChatState).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ receiptFiles: expect.arrayContaining([expect.objectContaining({ type: 'image' })]) })
    );
  });

  test('collects PDF when state.expectingImage is true', async () => {
    helpers.getChatState.mockResolvedValue({ expectingImage: true, receiptFiles: [] });
    const { req, res } = makeReqRes({
      From: 'whatsapp:+6591234567',
      NumMedia: '1',
      MediaUrl0: 'http://media.twilio.com/file.pdf',
      MediaContentType0: 'application/pdf',
    });
    await service.handleWhatsappWebhook(req, res);
    expect(helpers.updateChatState).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ receiptFiles: expect.arrayContaining([expect.objectContaining({ type: 'pdf' })]) })
    );
  });

  test('returns error TwiML for unsupported media type', async () => {
    helpers.getChatState.mockResolvedValue({ expectingImage: true, receiptFiles: [] });
    const { req, res } = makeReqRes({
      From: 'whatsapp:+6591234567',
      NumMedia: '1',
      MediaUrl0: 'http://media.twilio.com/file.mp4',
      MediaContentType0: 'video/mp4',
    });
    await service.handleWhatsappWebhook(req, res);
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining('Response'));
  });
});

// ── handleNotifyUser ──────────────────────────────────────────────────────────

describe('handleNotifyUser', () => {
  let service, twilioClient, helpers;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ADMIN_API_KEY;
    twilioClient = makeTwilioClient();
    helpers = makeHelpers();
    service = createBotService({ helpers, twilioClient, rateLimiter: makeRateLimiter() });
  });

  test('sends WhatsApp message and returns sid', async () => {
    const { req, res } = makeReqRes({ phone: '+6591234567', message: 'Hello user!' });
    await service.handleNotifyUser(req, res);
    expect(twilioClient.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'whatsapp:+6591234567', body: 'Hello user!' })
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, sid: 'SM-notify-123' });
  });

  test('prepends whatsapp: prefix when not present', async () => {
    const { req, res } = makeReqRes({ phone: '+6591234567', message: 'Hi' });
    await service.handleNotifyUser(req, res);
    expect(twilioClient.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'whatsapp:+6591234567' })
    );
  });

  test('does not double-prefix whatsapp: when already present', async () => {
    const { req, res } = makeReqRes({ phone: 'whatsapp:+6591234567', message: 'Hi' });
    await service.handleNotifyUser(req, res);
    expect(twilioClient.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'whatsapp:+6591234567' })
    );
    const callArg = twilioClient.messages.create.mock.calls[0][0];
    expect(callArg.to.split('whatsapp:').length - 1).toBe(1); // only one prefix
  });

  test('returns 400 when phone is missing', async () => {
    const { req, res } = makeReqRes({ message: 'Hello' });
    await service.handleNotifyUser(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'phone and message are required' });
  });

  test('returns 400 when message is missing', async () => {
    const { req, res } = makeReqRes({ phone: '+6591234567' });
    await service.handleNotifyUser(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns 400 when both phone and message are missing', async () => {
    const { req, res } = makeReqRes({});
    await service.handleNotifyUser(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns 401 when ADMIN_API_KEY is set and wrong key provided', async () => {
    process.env.ADMIN_API_KEY = 'secret-key';
    const svc = createBotService({ helpers: makeHelpers(), twilioClient: makeTwilioClient(), rateLimiter: makeRateLimiter() });
    const { req, res } = makeReqRes({ phone: '+65', message: 'Hi' }, { 'x-admin-api-key': 'wrong' });
    await svc.handleNotifyUser(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
    delete process.env.ADMIN_API_KEY;
  });

  test('returns 200 when ADMIN_API_KEY is set and correct key provided', async () => {
    process.env.ADMIN_API_KEY = 'my-secret';
    const svc = createBotService({ helpers: makeHelpers(), twilioClient: makeTwilioClient(), rateLimiter: makeRateLimiter() });
    const { req, res } = makeReqRes({ phone: '+65', message: 'Hi' }, { 'x-admin-api-key': 'my-secret' });
    await svc.handleNotifyUser(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    delete process.env.ADMIN_API_KEY;
  });

  test('returns 500 when Twilio throws', async () => {
    twilioClient.messages.create.mockRejectedValue(new Error('Twilio error'));
    const { req, res } = makeReqRes({ phone: '+65', message: 'Hi' });
    await service.handleNotifyUser(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ── Admin job handlers ────────────────────────────────────────────────────────

describe('handleListReceiptJobs', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns 200 with jobs array', async () => {
    const helpers = makeHelpers();
    helpers.receiptJobService.listRecentJobs.mockResolvedValue([{ jobId: 'job-1' }]);
    const service = createBotService({ helpers, twilioClient: makeTwilioClient(), rateLimiter: makeRateLimiter() });
    const { req, res } = makeReqRes({}, {}, {}, { limit: '10' });
    await service.handleListReceiptJobs(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, jobs: [{ jobId: 'job-1' }] });
  });

  test('returns 401 when admin key is wrong', async () => {
    process.env.ADMIN_API_KEY = 'secret';
    const service = createBotService({ helpers: makeHelpers(), twilioClient: makeTwilioClient(), rateLimiter: makeRateLimiter() });
    const { req, res } = makeReqRes({}, { 'x-admin-api-key': 'bad' });
    await service.handleListReceiptJobs(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
    delete process.env.ADMIN_API_KEY;
  });
});

describe('handleListFailedReceiptJobs', () => {
  test('returns failed jobs', async () => {
    const helpers = makeHelpers();
    helpers.receiptJobService.listFailedJobs.mockResolvedValue([{ jobId: 'failed-1', status: 'failed' }]);
    const service = createBotService({ helpers, twilioClient: makeTwilioClient(), rateLimiter: makeRateLimiter() });
    const { req, res } = makeReqRes({}, {}, {}, {});
    await service.handleListFailedReceiptJobs(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, jobs: [{ jobId: 'failed-1', status: 'failed' }] });
  });
});

describe('handleListDeadLetterReceiptJobs', () => {
  test('returns dead letter jobs', async () => {
    const helpers = makeHelpers();
    helpers.receiptJobService.listDeadLetterJobs.mockResolvedValue([{ jobId: 'dl-1', status: 'dead_letter' }]);
    const service = createBotService({ helpers, twilioClient: makeTwilioClient(), rateLimiter: makeRateLimiter() });
    const { req, res } = makeReqRes();
    await service.handleListDeadLetterReceiptJobs(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, jobs: [{ jobId: 'dl-1', status: 'dead_letter' }] });
  });
});

describe('handleGetReceiptJob', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns 404 when job not found', async () => {
    const helpers = makeHelpers();
    helpers.receiptJobService.getJob.mockResolvedValue(null);
    const service = createBotService({ helpers, twilioClient: makeTwilioClient(), rateLimiter: makeRateLimiter() });
    const { req, res } = makeReqRes({}, {}, { jobId: 'missing' });
    await service.handleGetReceiptJob(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'Job not found' });
  });

  test('returns 200 with job when found', async () => {
    const helpers = makeHelpers();
    helpers.receiptJobService.getJob.mockResolvedValue({ jobId: 'job-1', status: 'queued' });
    const service = createBotService({ helpers, twilioClient: makeTwilioClient(), rateLimiter: makeRateLimiter() });
    const { req, res } = makeReqRes({}, {}, { jobId: 'job-1' });
    await service.handleGetReceiptJob(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, job: { jobId: 'job-1', status: 'queued' } });
  });
});

describe('handleRetryReceiptJob', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns 404 when job does not exist', async () => {
    const helpers = makeHelpers();
    helpers.receiptJobService.getJob.mockResolvedValue(null);
    const service = createBotService({ helpers, twilioClient: makeTwilioClient(), rateLimiter: makeRateLimiter() });
    const { req, res } = makeReqRes({}, {}, { jobId: 'missing' });
    await service.handleRetryReceiptJob(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('retries existing job and returns 200', async () => {
    const helpers = makeHelpers();
    helpers.receiptJobService.getJob.mockResolvedValue({ jobId: 'job-1', status: 'failed' });
    retryReceiptQueueJob.mockResolvedValue({ queued: true });
    const service = createBotService({ helpers, twilioClient: makeTwilioClient(), rateLimiter: makeRateLimiter() });
    const { req, res } = makeReqRes({}, {}, { jobId: 'job-1' });
    await service.handleRetryReceiptJob(req, res);
    expect(helpers.receiptJobService.markRetryQueued).toHaveBeenCalledWith('job-1', expect.any(Object));
    expect(retryReceiptQueueJob).toHaveBeenCalledWith('job-1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, jobId: 'job-1', result: { queued: true } });
  });
});
