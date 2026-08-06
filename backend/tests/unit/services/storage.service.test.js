// tests/unit/services/storage.service.test.js
jest.mock('../../../src/config/supabase', () => {
  const { mockSupabase: createMock } = require('../../mocks/supabase.mock');
  const instance = createMock();
  return {
    supabaseAdmin: instance.client,
    supabase: instance.client,
    supabaseAuth: instance.client,
    __mockInstance: instance,
  };
});
jest.mock('../../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const {
  validateUpload, generateUploadUrl, generateDownloadUrl, verifyUploadedFile,
} = require('../../../src/services/storage.service');
const { BusinessRuleError } = require('../../../src/utils/errors');
const mockSupabaseInstance = require('../../../src/config/supabase').__mockInstance;

/** Helper: stubs verifyUploadedFile's internal download() to resolve the given bytes. */
function stubDownloadedBytes(bytes) {
  mockSupabaseInstance.mockNextStorageResponse({
    data: { arrayBuffer: () => Promise.resolve(Uint8Array.from(bytes).buffer) },
    error: null,
  });
}

describe('services/storage.service', () => {
  beforeEach(() => {
    mockSupabaseInstance.reset();
  });

  describe('magic-byte verification (matchesMagicBytes is private; exercised indirectly via verifyUploadedFile)', () => {
    it('JPEG signature matches image/jpeg -> verification succeeds', async () => {
      stubDownloadedBytes([0xFF, 0xD8, 0xFF, 0x00, 0x01]);
      await expect(verifyUploadedFile('p', 'image/jpeg')).resolves.toBe(true);
    });

    it('JPEG signature does NOT match image/png -> verification fails', async () => {
      stubDownloadedBytes([0xFF, 0xD8, 0xFF, 0x00]);
      await expect(verifyUploadedFile('p', 'image/png')).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('full 8-byte PNG signature matches image/png -> verification succeeds', async () => {
      stubDownloadedBytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      await expect(verifyUploadedFile('p', 'image/png')).resolves.toBe(true);
    });

    it('GIF89a (6-byte header) matches via the 4-byte "GIF8" prefix check', async () => {
      stubDownloadedBytes(Buffer.from('GIF89a', 'ascii'));
      await expect(verifyUploadedFile('p', 'image/gif')).resolves.toBe(true);
    });

    it('PDF "%PDF" prefix matches application/pdf', async () => {
      stubDownloadedBytes(Buffer.from('%PDF-1.4', 'ascii'));
      await expect(verifyUploadedFile('p', 'application/pdf')).resolves.toBe(true);
    });

    describe('WEBP special case (marker at byte offset 8, not 0)', () => {
      it('correct RIFF....WEBP structure matches', async () => {
        const buf = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP', 'ascii')]);
        stubDownloadedBytes(buf);
        await expect(verifyUploadedFile('p', 'image/webp')).resolves.toBe(true);
      });

      it('correct RIFF header but wrong marker at offset 8 does NOT match', async () => {
        const buf = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBM', 'ascii')]);
        stubDownloadedBytes(buf);
        await expect(verifyUploadedFile('p', 'image/webp')).rejects.toBeInstanceOf(BusinessRuleError);
      });

      it('a buffer shorter than 12 bytes does NOT match, without throwing an unexpected error', async () => {
        stubDownloadedBytes(Buffer.from('RIFF', 'ascii'));
        await expect(verifyUploadedFile('p', 'image/webp')).rejects.toBeInstanceOf(BusinessRuleError);
      });
    });

    it('unknown/unlisted content type -> permissive default, verification succeeds (no signature to check against)', async () => {
      stubDownloadedBytes([0x00, 0x01, 0x02]);
      await expect(verifyUploadedFile('p', 'application/octet-stream')).resolves.toBe(true);
    });

    it('a buffer shorter than the expected signature -> fails verification, no throw of an unexpected error', async () => {
      stubDownloadedBytes([0x89, 0x50]);
      await expect(verifyUploadedFile('p', 'image/png')).rejects.toBeInstanceOf(BusinessRuleError);
    });
  });

  describe('validateUpload', () => {
    it('throws BusinessRuleError for an unknown fileType', () => {
      expect(() => validateUpload('not_a_type', 'image/png', 100)).toThrow(BusinessRuleError);
    });

    it('accepts a fileSize exactly at the type\'s max (boundary)', () => {
      expect(() => validateUpload('avatar', 'image/png', 5 * 1024 * 1024)).not.toThrow();
    });

    it('rejects a fileSize one byte over the max', () => {
      expect(() => validateUpload('avatar', 'image/png', 5 * 1024 * 1024 + 1)).toThrow(BusinessRuleError);
    });

    it('accepts an explicitly-listed content type', () => {
      expect(() => validateUpload('proof', 'application/pdf', 1000)).not.toThrow();
    });

    it('accepts an unlisted image/* content type via the permissive image/* fallback', () => {
      expect(() => validateUpload('avatar', 'image/bmp', 1000)).not.toThrow();
    });

    it('rejects a content type not allowed and not image/* for a non-image fileType', () => {
      expect(() => validateUpload('avatar', 'application/pdf', 1000)).toThrow(BusinessRuleError);
    });

    it.each([
      ['proof', 10 * 1024 * 1024],
      ['task_proof', 10 * 1024 * 1024],
      ['cover_photo', 10 * 1024 * 1024],
      ['outcome_file', 50 * 1024 * 1024],
      ['milestone_photo', 10 * 1024 * 1024],
      ['avatar', 5 * 1024 * 1024],
      ['workspace_avatar', 5 * 1024 * 1024],
    ])('fileType %s has max size %i bytes', (fileType, maxSize) => {
      expect(() => validateUpload(fileType, 'image/png', maxSize)).not.toThrow();
      expect(() => validateUpload(fileType, 'image/png', maxSize + 1)).toThrow(BusinessRuleError);
    });
  });

  describe('generateUploadUrl', () => {
    it('requires either workspaceId or userId', async () => {
      await expect(
        generateUploadUrl({ folder: 'x', filename: 'a.png', contentType: 'image/png', fileSize: 100, fileType: 'avatar' })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('builds a workspaces/{id}/... path when workspaceId is provided', async () => {
      mockSupabaseInstance.mockNextStorageResponse({ data: { signedUrl: 'https://x' }, error: null });

      const result = await generateUploadUrl({
        workspaceId: 'ws-1', folder: 'covers', filename: 'a.png', contentType: 'image/png', fileSize: 100, fileType: 'cover_photo',
      });

      expect(result.file_path).toMatch(/^workspaces\/ws-1\/covers\//);
    });

    it('builds a users/{id}/... path when only userId is provided', async () => {
      mockSupabaseInstance.mockNextStorageResponse({ data: { signedUrl: 'https://x' }, error: null });

      const result = await generateUploadUrl({
        userId: 'user-1', folder: 'avatars', filename: 'a.png', contentType: 'image/png', fileSize: 100, fileType: 'avatar',
      });

      expect(result.file_path).toMatch(/^users\/user-1\/avatars\//);
    });

    it('throws a wrapped Error when the storage call errors', async () => {
      mockSupabaseInstance.mockNextStorageResponse({ data: null, error: { message: 'bucket not found' } });

      await expect(
        generateUploadUrl({ userId: 'user-1', folder: 'avatars', filename: 'a.png', contentType: 'image/png', fileSize: 100, fileType: 'avatar' })
      ).rejects.toThrow('Storage error: bucket not found');
    });

    it('runs upload validation BEFORE attempting storage', async () => {
      await expect(
        generateUploadUrl({ userId: 'user-1', folder: 'avatars', filename: 'a.png', contentType: 'image/png', fileSize: 999999999, fileType: 'avatar' })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });
  });

  describe('generateDownloadUrl', () => {
    it('returns a download_url and expires_in', async () => {
      mockSupabaseInstance.mockNextStorageResponse({ data: { signedUrl: 'https://x' }, error: null });

      const result = await generateDownloadUrl('path/to/file.png', 600);

      expect(result).toEqual({ download_url: 'https://x', expires_in: 600 });
    });
  });

  describe('verifyUploadedFile', () => {
    it('skips verification entirely when FILE_VERIFICATION_ENABLED=false', async () => {
      jest.resetModules();
      process.env.FILE_VERIFICATION_ENABLED = 'false';

      jest.doMock('../../../src/config/supabase', () => ({
        supabaseAdmin: mockSupabaseInstance.client,
        supabase: mockSupabaseInstance.client,
        supabaseAuth: mockSupabaseInstance.client,
      }));
      jest.doMock('../../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

      const freshStorage = require('../../../src/services/storage.service');
      const result = await freshStorage.verifyUploadedFile('some/path', 'image/png');

      expect(result).toBe(true);
      expect(mockSupabaseInstance.getCalls().length).toBe(0);

      delete process.env.FILE_VERIFICATION_ENABLED;
      jest.resetModules();
    });

    it('throws BusinessRuleError when the downloaded bytes do not match the declared type', async () => {
      mockSupabaseInstance.mockNextStorageResponse({
        data: { arrayBuffer: () => Promise.resolve(new Uint8Array([0x00, 0x00, 0x00, 0x00]).buffer) },
        error: null,
      });

      await expect(verifyUploadedFile('some/path', 'image/png')).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('succeeds when the downloaded bytes DO match the declared type', async () => {
      const pngBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      mockSupabaseInstance.mockNextStorageResponse({
        data: { arrayBuffer: () => Promise.resolve(pngBytes.buffer) },
        error: null,
      });

      await expect(verifyUploadedFile('some/path', 'image/png')).resolves.toBe(true);
    });

    it('wraps a download error in a generic BusinessRuleError (fail closed, no raw error message leak)', async () => {
      mockSupabaseInstance.mockNextStorageResponse({ data: null, error: { message: 'storage backend down' } });

      let caught;
      try {
        await verifyUploadedFile('some/path', 'image/png');
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(BusinessRuleError);
      expect(caught.message).not.toContain('storage backend down');
    });
  });
});
