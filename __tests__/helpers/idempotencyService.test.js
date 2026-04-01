const mockRedis = {
  set: jest.fn(),
};

jest.mock('../../helpers/services/redisClient', () => ({
  getRedis: () => mockRedis,
}));

const { createIdempotencyService } = require('../../helpers/services/idempotencyService');

const mockLogger = { logToFile: jest.fn() };

describe('idempotencyService', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = createIdempotencyService({}, mockLogger);
  });

  describe('claimWebhookOnce', () => {
    test('claims a new webhook and returns claimed=true', async () => {
      mockRedis.set.mockResolvedValue('OK');
      const result = await service.claimWebhookOnce({
        messageSid: 'SM123',
        from: '+6591234567',
        body: 'hello',
        mediaUrls: [],
      });
      expect(result.claimed).toBe(true);
      expect(result.key).toBe('idem:webhook:SM123');
    });

    test('returns claimed=false for a duplicate webhook', async () => {
      mockRedis.set.mockResolvedValue(null); // null = key already existed (NX failed)
      const result = await service.claimWebhookOnce({ messageSid: 'SM123' });
      expect(result.claimed).toBe(false);
    });

    test('logs skipped duplicate', async () => {
      mockRedis.set.mockResolvedValue(null);
      await service.claimWebhookOnce({ messageSid: 'SM123' });
      expect(mockLogger.logToFile).toHaveBeenCalledWith(
        expect.stringContaining('[idempotency]')
      );
    });

    test('uses fallback hash key when no messageSid provided', async () => {
      mockRedis.set.mockResolvedValue('OK');
      const result = await service.claimWebhookOnce({
        from: '+6591234567',
        body: 'hello',
        mediaUrls: [],
      });
      expect(result.key).toMatch(/^idem:webhook:fallback:/);
    });

    test('same fallback key for identical payloads (deterministic hash)', async () => {
      mockRedis.set.mockResolvedValue('OK');
      const payload = { from: '+65', body: 'test', mediaUrls: ['http://img.jpg'] };
      const r1 = await service.claimWebhookOnce(payload);
      const r2 = await service.claimWebhookOnce(payload);
      expect(r1.key).toBe(r2.key);
    });

    test('uses atomic NX flag to prevent race conditions', async () => {
      mockRedis.set.mockResolvedValue('OK');
      await service.claimWebhookOnce({ messageSid: 'SM-unique' });
      expect(mockRedis.set).toHaveBeenCalledWith(
        'idem:webhook:SM-unique',
        '1',
        'EX',
        expect.any(Number),
        'NX'
      );
    });

    test('respects IDEMPOTENCY_TTL_SECONDS env var', async () => {
      process.env.IDEMPOTENCY_TTL_SECONDS = '3600';
      const svc = createIdempotencyService({}, mockLogger);
      mockRedis.set.mockResolvedValue('OK');
      await svc.claimWebhookOnce({ messageSid: 'SM-ttl' });
      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.any(String),
        '1',
        'EX',
        3600,
        'NX'
      );
      delete process.env.IDEMPOTENCY_TTL_SECONDS;
    });
  });

  describe('claimReceiptBatchOnce', () => {
    test('claims a new receipt batch and returns claimed=true', async () => {
      mockRedis.set.mockResolvedValue('OK');
      const result = await service.claimReceiptBatchOnce('+6591234567', 'batch-hash-abc123');
      expect(result.claimed).toBe(true);
      expect(result.key).toBe('idem:receipt_batch:+6591234567:batch-hash-abc123');
    });

    test('returns claimed=false for a duplicate batch', async () => {
      mockRedis.set.mockResolvedValue(null);
      const result = await service.claimReceiptBatchOnce('+6591234567', 'duplicate-hash');
      expect(result.claimed).toBe(false);
    });

    test('logs skipped duplicate batch', async () => {
      mockRedis.set.mockResolvedValue(null);
      await service.claimReceiptBatchOnce('+65', 'hash');
      expect(mockLogger.logToFile).toHaveBeenCalledWith(
        expect.stringContaining('[idempotency]')
      );
    });

    test('different phones have different keys for the same hash', async () => {
      mockRedis.set.mockResolvedValue('OK');
      const r1 = await service.claimReceiptBatchOnce('+6591234567', 'same-hash');
      const r2 = await service.claimReceiptBatchOnce('+6598765432', 'same-hash');
      expect(r1.key).not.toBe(r2.key);
    });

    test('different hashes have different keys for the same phone', async () => {
      mockRedis.set.mockResolvedValue('OK');
      const r1 = await service.claimReceiptBatchOnce('+65', 'hash-A');
      const r2 = await service.claimReceiptBatchOnce('+65', 'hash-B');
      expect(r1.key).not.toBe(r2.key);
    });

    test('uses NX flag for atomic claim', async () => {
      mockRedis.set.mockResolvedValue('OK');
      await service.claimReceiptBatchOnce('+65', 'hash-xyz');
      expect(mockRedis.set).toHaveBeenCalledWith(
        'idem:receipt_batch:+65:hash-xyz',
        '1',
        'EX',
        expect.any(Number),
        'NX'
      );
    });
  });
});
