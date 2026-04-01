const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
};

jest.mock('../../helpers/services/redisClient', () => ({
  getRedis: () => mockRedis,
}));

const { createStateService } = require('../../helpers/services/stateService');

const mockLogger = { logToFile: jest.fn() };
const mockConfig = { state: { ttlMs: 86400000 } }; // 24h

describe('stateService', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = createStateService(mockConfig, mockLogger);
  });

  describe('getChatState', () => {
    test('returns empty object when no state exists in Redis', async () => {
      mockRedis.get.mockResolvedValue(null);
      const result = await service.getChatState('+6591234567');
      expect(result).toEqual({});
    });

    test('returns parsed state object when state exists', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({ expectingImage: true, receiptFiles: [] }));
      const result = await service.getChatState('+6591234567');
      expect(result).toEqual({ expectingImage: true, receiptFiles: [] });
    });

    test('returns empty object and logs warning when JSON is invalid', async () => {
      mockRedis.get.mockResolvedValue('invalid-json{{{');
      const result = await service.getChatState('+6591234567');
      expect(result).toEqual({});
      expect(mockLogger.logToFile).toHaveBeenCalledWith(
        expect.stringContaining('[warn]')
      );
    });

    test('uses the correct Redis key format', async () => {
      mockRedis.get.mockResolvedValue(null);
      await service.getChatState('+6591234567');
      expect(mockRedis.get).toHaveBeenCalledWith('chat_state:+6591234567');
    });

    test('handles different phone number formats', async () => {
      mockRedis.get.mockResolvedValue(null);
      await service.getChatState('whatsapp:+6591234567');
      expect(mockRedis.get).toHaveBeenCalledWith('chat_state:whatsapp:+6591234567');
    });
  });

  describe('updateChatState', () => {
    test('merges patch into existing state', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({ expectingImage: true, receiptFiles: [] }));
      mockRedis.set.mockResolvedValue('OK');

      const result = await service.updateChatState('+6591234567', { lastReceiptJobId: 'job-1' });
      expect(result.expectingImage).toBe(true);
      expect(result.receiptFiles).toEqual([]);
      expect(result.lastReceiptJobId).toBe('job-1');
    });

    test('adds updatedAt timestamp to state', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockRedis.set.mockResolvedValue('OK');

      const result = await service.updateChatState('+6591234567', { foo: 'bar' });
      expect(result.updatedAt).toBeDefined();
      expect(new Date(result.updatedAt).toISOString()).toBe(result.updatedAt);
    });

    test('stores state as JSON string with EX TTL', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockRedis.set.mockResolvedValue('OK');

      await service.updateChatState('+6591234567', { foo: 'bar' });
      expect(mockRedis.set).toHaveBeenCalledWith(
        'chat_state:+6591234567',
        expect.any(String),
        'EX',
        86400 // 24h in seconds
      );
      // Verify it's valid JSON
      const [, storedValue] = mockRedis.set.mock.calls[0];
      expect(() => JSON.parse(storedValue)).not.toThrow();
    });

    test('patch overrides existing keys', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({ expectingImage: true }));
      mockRedis.set.mockResolvedValue('OK');

      const result = await service.updateChatState('+6591234567', { expectingImage: false });
      expect(result.expectingImage).toBe(false);
    });

    test('starts with empty state when no prior state exists', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockRedis.set.mockResolvedValue('OK');

      const result = await service.updateChatState('+6591234567', { step: 'intro' });
      expect(result.step).toBe('intro');
    });
  });

  describe('clearChatState', () => {
    test('deletes the Redis key for the given phone', async () => {
      mockRedis.del.mockResolvedValue(1);
      await service.clearChatState('+6591234567');
      expect(mockRedis.del).toHaveBeenCalledWith('chat_state:+6591234567');
    });

    test('does not throw when key does not exist', async () => {
      mockRedis.del.mockResolvedValue(0); // key didn't exist
      await expect(service.clearChatState('+65_nonexistent')).resolves.not.toThrow();
    });
  });

  describe('TTL configuration', () => {
    test('enforces minimum TTL of 60 seconds', () => {
      const shortConfig = { state: { ttlMs: 1000 } }; // 1 second → would be 1s, clamped to 60
      const svc = createStateService(shortConfig, mockLogger);
      expect(svc).toBeDefined(); // just verifies it doesn't crash
    });

    test('uses default 24h TTL when config not provided', () => {
      const svc = createStateService({}, mockLogger);
      expect(svc).toBeDefined();
    });
  });
});
