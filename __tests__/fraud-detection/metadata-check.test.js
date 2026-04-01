jest.mock('sharp');
jest.mock('exif-reader');

const sharp = require('sharp');
const exifReader = require('exif-reader');
const { analyzeImageMetadata, checkImageQuality } = require('../../fraud-detection/metadata-check');

const fakeBuffer = Buffer.from('fake-image-data');

describe('analyzeImageMetadata', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('detects AI software tag in EXIF (Stable Diffusion)', async () => {
    sharp.mockReturnValue({
      metadata: jest.fn().mockResolvedValue({
        exif: Buffer.from('fake-exif'),
        width: 100,
        height: 100,
      }),
    });
    exifReader.mockReturnValue({
      Image: { Software: 'Stable Diffusion v2', Make: null, Model: null },
      Photo: {},
    });

    const result = await analyzeImageMetadata(fakeBuffer);
    expect(result.aiSoftwareTag).toBe(true);
    expect(result.exifPresent).toBe(true);
    expect(result.redFlags).toContain('AI software detected: Stable Diffusion v2');
  });

  test('detects DALL-E AI software tag', async () => {
    sharp.mockReturnValue({
      metadata: jest.fn().mockResolvedValue({ exif: Buffer.from('fake'), width: 100, height: 100 }),
    });
    exifReader.mockReturnValue({
      Image: { Software: 'DALL-E 3', Make: null, Model: null },
      Photo: {},
    });

    const result = await analyzeImageMetadata(fakeBuffer);
    expect(result.aiSoftwareTag).toBe(true);
  });

  test('sets whatsappStrippedExif when no EXIF present', async () => {
    sharp.mockReturnValue({
      metadata: jest.fn().mockResolvedValue({ width: 1080, height: 1920 }),
    });

    const result = await analyzeImageMetadata(fakeBuffer);
    expect(result.whatsappStrippedExif).toBe(true);
    expect(result.exifPresent).toBe(false);
    expect(result.redFlags).toContain('No EXIF metadata (WhatsApp may have stripped it)');
  });

  test('flags perfect 64-pixel alignment as AI generation pattern', async () => {
    sharp.mockReturnValue({
      metadata: jest.fn().mockResolvedValue({ width: 512, height: 512 }),
    });

    const result = await analyzeImageMetadata(fakeBuffer);
    expect(result.redFlags).toContain('Perfect 64-pixel alignment (AI generation pattern)');
  });

  test('does not flag non-64-aligned dimensions', async () => {
    sharp.mockReturnValue({
      metadata: jest.fn().mockResolvedValue({
        exif: Buffer.from('fake'),
        width: 3024,
        height: 4032,
      }),
    });
    exifReader.mockReturnValue({
      Image: { Software: 'Canon', Make: 'Canon', Model: 'EOS R5' },
      Photo: {},
    });

    const result = await analyzeImageMetadata(fakeBuffer);
    expect(result.redFlags).not.toContain('Perfect 64-pixel alignment (AI generation pattern)');
  });

  test('flags missing camera make/model', async () => {
    sharp.mockReturnValue({
      metadata: jest.fn().mockResolvedValue({ exif: Buffer.from('fake'), width: 100, height: 100 }),
    });
    exifReader.mockReturnValue({
      Image: { Software: 'SomeEditor', Make: undefined, Model: undefined },
      Photo: {},
    });

    const result = await analyzeImageMetadata(fakeBuffer);
    expect(result.redFlags).toContain('No camera make/model in EXIF');
  });

  test('returns clean signals for normal camera photo', async () => {
    sharp.mockReturnValue({
      metadata: jest.fn().mockResolvedValue({
        exif: Buffer.from('fake-exif'),
        width: 3024,
        height: 4032,
      }),
    });
    exifReader.mockReturnValue({
      Image: { Software: 'Canon Camera Firmware', Make: 'Canon', Model: 'EOS R5', DateTime: '2024:01:01 10:00:00' },
      Photo: { DateTimeOriginal: '2024:01:01 10:00:00' },
    });

    const result = await analyzeImageMetadata(fakeBuffer);
    expect(result.aiSoftwareTag).toBe(false);
    expect(result.exifPresent).toBe(true);
    expect(result.cameraInfo).toMatchObject({ make: 'Canon', model: 'EOS R5' });
    expect(result.redFlags).toHaveLength(0);
  });

  test('handles sharp error gracefully and returns default signals', async () => {
    sharp.mockReturnValue({
      metadata: jest.fn().mockRejectedValue(new Error('Sharp processing failed')),
    });

    const result = await analyzeImageMetadata(fakeBuffer);
    expect(result).toBeDefined();
    expect(result.exifPresent).toBe(false);
    expect(result.aiSoftwareTag).toBe(false);
  });

  test('handles exif-reader parse error gracefully', async () => {
    sharp.mockReturnValue({
      metadata: jest.fn().mockResolvedValue({ exif: Buffer.from('corrupt'), width: 100, height: 100 }),
    });
    exifReader.mockImplementation(() => { throw new Error('Invalid EXIF'); });

    const result = await analyzeImageMetadata(fakeBuffer);
    expect(result.exifPresent).toBe(true);
    expect(result.aiSoftwareTag).toBe(false);
  });
});

describe('checkImageQuality', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('detects too-perfect image when variance < 5', async () => {
    sharp.mockReturnValue({
      stats: jest.fn().mockResolvedValue({
        channels: [{ stdev: 1 }, { stdev: 2 }, { stdev: 1 }],
      }),
    });

    const result = await checkImageQuality(fakeBuffer);
    expect(result.tooPerfect).toBe(true);
    expect(result.reason).toBe('Unusually low noise/variance (too clean)');
    expect(result.variance).toBeCloseTo(1.33, 1);
  });

  test('normal photo passes quality check', async () => {
    sharp.mockReturnValue({
      stats: jest.fn().mockResolvedValue({
        channels: [{ stdev: 30 }, { stdev: 25 }, { stdev: 28 }],
      }),
    });

    const result = await checkImageQuality(fakeBuffer);
    expect(result.tooPerfect).toBe(false);
    expect(result.reason).toBeNull();
  });

  test('borderline variance (exactly 5) is not too perfect', async () => {
    sharp.mockReturnValue({
      stats: jest.fn().mockResolvedValue({
        channels: [{ stdev: 5 }, { stdev: 5 }, { stdev: 5 }],
      }),
    });

    const result = await checkImageQuality(fakeBuffer);
    expect(result.tooPerfect).toBe(false);
  });

  test('handles sharp error gracefully', async () => {
    sharp.mockReturnValue({
      stats: jest.fn().mockRejectedValue(new Error('Stats failed')),
    });

    const result = await checkImageQuality(fakeBuffer);
    expect(result.tooPerfect).toBe(false);
    expect(result.variance).toBeNull();
    expect(result.reason).toBeNull();
  });
});
