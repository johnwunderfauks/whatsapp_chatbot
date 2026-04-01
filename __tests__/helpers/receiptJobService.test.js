const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  zadd: jest.fn(),
  zrem: jest.fn(),
  zrevrange: jest.fn(),
  zremrangebyrank: jest.fn(),
  lpush: jest.fn(),
  ltrim: jest.fn(),
  lrange: jest.fn(),
  expire: jest.fn(),
};

jest.mock('../../helpers/services/redisClient', () => ({
  getRedis: () => mockRedis,
}));

const { createReceiptJobService, JOB_STATUS } = require('../../helpers/services/receiptJobService');

const mockLogger = { logToFile: jest.fn() };

function setupDefaultRedisOk() {
  mockRedis.set.mockResolvedValue('OK');
  mockRedis.zadd.mockResolvedValue(1);
  mockRedis.zrem.mockResolvedValue(0);
  mockRedis.lpush.mockResolvedValue(1);
  mockRedis.ltrim.mockResolvedValue('OK');
  mockRedis.expire.mockResolvedValue(1);
  mockRedis.zremrangebyrank.mockResolvedValue(0);
}

describe('JOB_STATUS constants', () => {
  test('exports all required statuses', () => {
    expect(JOB_STATUS.QUEUED).toBe('queued');
    expect(JOB_STATUS.PROCESSING).toBe('processing');
    expect(JOB_STATUS.COMPLETED).toBe('completed');
    expect(JOB_STATUS.FAILED).toBe('failed');
    expect(JOB_STATUS.DEAD_LETTER).toBe('dead_letter');
    expect(JOB_STATUS.RETRY_QUEUED).toBe('retry_queued');
  });

  test('is frozen (immutable)', () => {
    expect(Object.isFrozen(JOB_STATUS)).toBe(true);
  });
});

describe('receiptJobService', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    setupDefaultRedisOk();
    service = createReceiptJobService({}, mockLogger);
  });

  describe('createQueuedJob', () => {
    test('creates job with QUEUED status', async () => {
      const job = await service.createQueuedJob({
        jobId: 'job-001',
        phone: '+6591234567',
        profileId: 42,
        files: [{ url: 'http://test.com/img.jpg', type: 'image' }],
        batchHash: 'abc123',
        sourceMessageSid: 'SM123',
        attemptsAllowed: 3,
      });

      expect(job.status).toBe(JOB_STATUS.QUEUED);
      expect(job.jobId).toBe('job-001');
      expect(job.phone).toBe('+6591234567');
      expect(job.profileId).toBe(42);
      expect(job.fileCount).toBe(1);
      expect(job.attemptsMade).toBe(0);
      expect(job.attemptsAllowed).toBe(3);
      expect(job.jobType).toBe('receipt');
    });

    test('sets all timestamps on creation', async () => {
      const job = await service.createQueuedJob({ jobId: 'job-002', phone: '+65', profileId: 1 });
      expect(job.createdAt).toBeDefined();
      expect(job.updatedAt).toBeDefined();
      expect(job.queuedAt).toBeDefined();
      expect(job.startedAt).toBeNull();
      expect(job.completedAt).toBeNull();
      expect(job.failedAt).toBeNull();
    });

    test('persists job to Redis with TTL', async () => {
      await service.createQueuedJob({ jobId: 'job-003', phone: '+65', profileId: 1 });
      expect(mockRedis.set).toHaveBeenCalledWith(
        'receipt_job:job-003',
        expect.any(String),
        'EX',
        expect.any(Number)
      );
    });

    test('adds job to all index', async () => {
      await service.createQueuedJob({ jobId: 'job-004', phone: '+65', profileId: 1 });
      expect(mockRedis.zadd).toHaveBeenCalledWith('receipt_job:index:all', expect.any(Number), 'job-004');
    });

    test('handles empty files array', async () => {
      const job = await service.createQueuedJob({ jobId: 'job-005', phone: '+65', profileId: 1, files: [] });
      expect(job.fileCount).toBe(0);
      expect(job.files).toEqual([]);
    });

    test('uses default attemptsAllowed from env when not provided', async () => {
      const job = await service.createQueuedJob({ jobId: 'job-006', phone: '+65', profileId: 1 });
      expect(job.attemptsAllowed).toBeGreaterThan(0);
    });
  });

  describe('getJob', () => {
    test('returns null when job does not exist', async () => {
      mockRedis.get.mockResolvedValue(null);
      const result = await service.getJob('nonexistent');
      expect(result).toBeNull();
    });

    test('returns parsed job when it exists', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({ jobId: 'job-007', status: JOB_STATUS.QUEUED }));
      const result = await service.getJob('job-007');
      expect(result).toMatchObject({ jobId: 'job-007', status: 'queued' });
    });

    test('returns null and logs error for invalid JSON', async () => {
      mockRedis.get.mockResolvedValue('invalid-json{');
      const result = await service.getJob('bad-job');
      expect(result).toBeNull();
      expect(mockLogger.logToFile).toHaveBeenCalledWith(expect.stringContaining('[error]'));
    });
  });

  describe('markProcessing', () => {
    test('transitions job to PROCESSING status', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({
        jobId: 'job-010', status: JOB_STATUS.QUEUED, attemptsMade: 0,
      }));
      const result = await service.markProcessing('job-010');
      expect(result.status).toBe(JOB_STATUS.PROCESSING);
      expect(result.startedAt).not.toBeNull();
    });

    test('clears lastError on transition to PROCESSING', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({
        jobId: 'job-011', status: JOB_STATUS.FAILED, lastError: { message: 'old error' },
      }));
      const result = await service.markProcessing('job-011');
      expect(result.lastError).toBeNull();
      expect(result.failedAt).toBeNull();
    });

    test('returns null when job not found', async () => {
      mockRedis.get.mockResolvedValue(null);
      const result = await service.markProcessing('nonexistent');
      expect(result).toBeNull();
    });

    test('does not overwrite startedAt if already set', async () => {
      const existingStartedAt = '2024-01-01T10:00:00.000Z';
      mockRedis.get.mockResolvedValue(JSON.stringify({
        jobId: 'job-012', status: JOB_STATUS.FAILED, startedAt: existingStartedAt,
      }));
      const result = await service.markProcessing('job-012');
      expect(result.startedAt).toBe(existingStartedAt);
    });
  });

  describe('markCompleted', () => {
    test('transitions job to COMPLETED status', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({ jobId: 'job-020', status: JOB_STATUS.PROCESSING }));
      const result = await service.markCompleted('job-020', { receiptId: 99, fraudScore: 5 });
      expect(result.status).toBe(JOB_STATUS.COMPLETED);
      expect(result.completedAt).not.toBeNull();
      expect(result.receiptId).toBe(99);
      expect(result.fraudScore).toBe(5);
    });

    test('clears lastError on completion', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({
        jobId: 'job-021', status: JOB_STATUS.PROCESSING, lastError: { message: 'previous' },
      }));
      const result = await service.markCompleted('job-021');
      expect(result.lastError).toBeNull();
    });

    test('returns null when job not found', async () => {
      mockRedis.get.mockResolvedValue(null);
      const result = await service.markCompleted('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('markFailed', () => {
    test('transitions to FAILED when attempts remaining', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({
        jobId: 'job-030', status: JOB_STATUS.PROCESSING, attemptsAllowed: 3,
      }));
      const result = await service.markFailed('job-030', new Error('OCR failed'), { attemptsMade: 1 });
      expect(result.status).toBe(JOB_STATUS.FAILED);
      expect(result.lastError.message).toBe('OCR failed');
      expect(result.failedAt).not.toBeNull();
      expect(result.deadLetterAt).toBeNull();
    });

    test('transitions to DEAD_LETTER when attempts exhausted', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({
        jobId: 'job-031', status: JOB_STATUS.PROCESSING, attemptsAllowed: 3,
      }));
      const result = await service.markFailed('job-031', new Error('Permanent'), { attemptsMade: 3 });
      expect(result.status).toBe(JOB_STATUS.DEAD_LETTER);
      expect(result.deadLetterAt).not.toBeNull();
    });

    test('normalizes string error to error object', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({
        jobId: 'job-032', attemptsAllowed: 3,
      }));
      const result = await service.markFailed('job-032', 'something went wrong', { attemptsMade: 1 });
      expect(result.lastError).toMatchObject({ message: 'something went wrong' });
    });

    test('adds job to failed index', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({
        jobId: 'job-033', attemptsAllowed: 3,
      }));
      await service.markFailed('job-033', new Error('err'), { attemptsMade: 1 });
      expect(mockRedis.zadd).toHaveBeenCalledWith('receipt_job:index:failed', expect.any(Number), 'job-033');
    });

    test('adds job to dead_letter index when exhausted', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({
        jobId: 'job-034', attemptsAllowed: 2,
      }));
      await service.markFailed('job-034', new Error('err'), { attemptsMade: 2 });
      expect(mockRedis.zadd).toHaveBeenCalledWith('receipt_job:index:dead_letter', expect.any(Number), 'job-034');
    });

    test('returns null when job not found', async () => {
      mockRedis.get.mockResolvedValue(null);
      const result = await service.markFailed('nonexistent', new Error('err'));
      expect(result).toBeNull();
    });
  });

  describe('markRetryQueued', () => {
    test('transitions job to RETRY_QUEUED status', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({ jobId: 'job-040', status: JOB_STATUS.FAILED }));
      const result = await service.markRetryQueued('job-040');
      expect(result.status).toBe(JOB_STATUS.RETRY_QUEUED);
    });
  });

  describe('listRecentJobs', () => {
    test('returns empty array when no jobs in index', async () => {
      mockRedis.zrevrange.mockResolvedValue([]);
      const result = await service.listRecentJobs();
      expect(result).toEqual([]);
    });

    test('returns hydrated jobs from index', async () => {
      mockRedis.zrevrange.mockResolvedValue(['job-001', 'job-002']);
      mockRedis.get
        .mockResolvedValueOnce(JSON.stringify({ jobId: 'job-001', status: JOB_STATUS.COMPLETED }))
        .mockResolvedValueOnce(JSON.stringify({ jobId: 'job-002', status: JOB_STATUS.QUEUED }));

      const result = await service.listRecentJobs();
      expect(result).toHaveLength(2);
      expect(result[0].jobId).toBe('job-001');
      expect(result[1].jobId).toBe('job-002');
    });

    test('filters out null jobs (stale index entries)', async () => {
      mockRedis.zrevrange.mockResolvedValue(['job-001', 'stale-job']);
      mockRedis.get
        .mockResolvedValueOnce(JSON.stringify({ jobId: 'job-001', status: JOB_STATUS.QUEUED }))
        .mockResolvedValueOnce(null);

      const result = await service.listRecentJobs();
      expect(result).toHaveLength(1);
    });
  });

  describe('listFailedJobs / listDeadLetterJobs', () => {
    test('listFailedJobs queries the failed index', async () => {
      mockRedis.zrevrange.mockResolvedValue([]);
      await service.listFailedJobs();
      expect(mockRedis.zrevrange).toHaveBeenCalledWith('receipt_job:index:failed', 0, expect.any(Number));
    });

    test('listDeadLetterJobs queries the dead_letter index', async () => {
      mockRedis.zrevrange.mockResolvedValue([]);
      await service.listDeadLetterJobs();
      expect(mockRedis.zrevrange).toHaveBeenCalledWith('receipt_job:index:dead_letter', 0, expect.any(Number));
    });
  });
});
