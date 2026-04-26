// tests/storage.service.test.js

// ─────────────────────────────────────────────
// Shared mocks
// ─────────────────────────────────────────────

const mockCreateSignedUploadUrl = jest.fn();
const mockCreateSignedUrl = jest.fn();
const mockRemove = jest.fn();

jest.mock('../config/supabase', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
  supabase: {
    storage: {
      from: jest.fn(() => ({
        createSignedUploadUrl: mockCreateSignedUploadUrl,
        createSignedUrl: mockCreateSignedUrl,
        remove: mockRemove,
      })),
    },
  },
}));

const mockLoggerError = jest.fn();
jest.mock('../utils/logger', () => ({ error: mockLoggerError }));

class BusinessRuleError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'BusinessRuleError';
  }
}
jest.mock('../utils/errors', () => ({ BusinessRuleError }));

// ─────────────────────────────────────────────
// Subjects under test
// ─────────────────────────────────────────────
const {
  validateUpload,
  generateUploadUrl,
  generateDownloadUrl,
  deleteFile,
} = require('../src/services/storage.service');

// ─────────────────────────────────────────────
// storage.service
// ─────────────────────────────────────────────
describe('storage.service', () => {
  beforeEach(() => jest.clearAllMocks());

  // ── validateUpload() ───────────────────────
  describe('validateUpload()', () => {
    it('throws BusinessRuleError for an unknown fileType', () => {
      expect(() => validateUpload('unknown_type', 'image/png', 100)).toThrow(
        'Unknown file type: unknown_type',
      );
    });

    it('throws BusinessRuleError when file exceeds max size', () => {
      // avatar max is 5 MB; send 6 MB
      expect(() => validateUpload('avatar', 'image/png', 6 * 1024 * 1024)).toThrow(
        /File too large/,
      );
    });

    it('includes the MB limit in the size error message', () => {
      expect(() => validateUpload('avatar', 'image/png', 6 * 1024 * 1024)).toThrow('5MB');
    });

    it('throws BusinessRuleError for a disallowed content type', () => {
      // avatar does not allow PDF
      expect(() => validateUpload('avatar', 'application/pdf', 1000)).toThrow(
        /not allowed for avatar/,
      );
    });

    it('passes for an explicitly listed content type', () => {
      expect(() => validateUpload('avatar', 'image/jpeg', 1000)).not.toThrow();
    });

    it('passes for any image/* type when the category allows images', () => {
      // image/avif is not in the explicit list but starts with 'image/'
      expect(() => validateUpload('cover_photo', 'image/avif', 1000)).not.toThrow();
    });

    it('passes for outcome_file with a PDF at exactly 50 MB', () => {
      expect(() =>
        validateUpload('outcome_file', 'application/pdf', 50 * 1024 * 1024),
      ).not.toThrow();
    });

    it('throws when outcome_file exceeds 50 MB', () => {
      expect(() =>
        validateUpload('outcome_file', 'application/pdf', 50 * 1024 * 1024 + 1),
      ).toThrow(/File too large/);
    });
  });

  // ── generateUploadUrl() ────────────────────
  describe('generateUploadUrl()', () => {
    const baseArgs = {
      folder: 'avatars',
      filename: 'photo.png',
      contentType: 'image/png',
      fileSize: 1024,
      fileType: 'avatar',
    };

    it('builds a workspace-scoped path when workspaceId is supplied', async () => {
      mockCreateSignedUploadUrl.mockResolvedValue({
        data: { signedUrl: 'https://example.com/upload' },
        error: null,
      });

      const result = await generateUploadUrl({ ...baseArgs, workspaceId: 'ws-42' });

      expect(result.file_path).toMatch(/^workspaces\/ws-42\/avatars\//);
      expect(result.upload_url).toBe('https://example.com/upload');
      expect(result.expires_in).toBe(300);
    });

    it('builds a user-scoped path when only userId is supplied', async () => {
      mockCreateSignedUploadUrl.mockResolvedValue({
        data: { signedUrl: 'https://example.com/upload' },
        error: null,
      });

      const result = await generateUploadUrl({ ...baseArgs, userId: 'u-99' });

      expect(result.file_path).toMatch(/^users\/u-99\/avatars\//);
    });

    it('workspaceId takes precedence over userId', async () => {
      mockCreateSignedUploadUrl.mockResolvedValue({
        data: { signedUrl: 'https://example.com/upload' },
        error: null,
      });

      const result = await generateUploadUrl({
        ...baseArgs,
        workspaceId: 'ws-1',
        userId: 'u-1',
      });

      expect(result.file_path).toMatch(/^workspaces\/ws-1\//);
    });

    it('throws BusinessRuleError when neither workspaceId nor userId is provided', async () => {
      await expect(generateUploadUrl(baseArgs)).rejects.toThrow(
        'Either workspaceId or userId is required',
      );
    });

    it('generates a safe filename preserving the original extension', async () => {
      mockCreateSignedUploadUrl.mockResolvedValue({
        data: { signedUrl: 'https://example.com/upload' },
        error: null,
      });

      const result = await generateUploadUrl({ ...baseArgs, workspaceId: 'ws-1' });

      expect(result.file_path).toMatch(/\.png$/);
    });

    it('falls back to .bin extension when filename has no dot', async () => {
      mockCreateSignedUploadUrl.mockResolvedValue({
        data: { signedUrl: 'https://example.com/upload' },
        error: null,
      });

      const result = await generateUploadUrl({
        ...baseArgs,
        filename: 'nodotfile',
        workspaceId: 'ws-1',
      });

      expect(result.file_path).toMatch(/\.bin$/);
    });

    it('throws when supabase storage returns an error', async () => {
      mockCreateSignedUploadUrl.mockResolvedValue({
        data: null,
        error: { message: 'Bucket not found' },
      });

      await expect(generateUploadUrl({ ...baseArgs, workspaceId: 'ws-1' })).rejects.toThrow(
        'Storage error: Bucket not found',
      );
    });

    it('rejects invalid file types before calling supabase', async () => {
      await expect(
        generateUploadUrl({
          ...baseArgs,
          workspaceId: 'ws-1',
          fileType: 'avatar',
          contentType: 'application/pdf', // not allowed for avatar
        }),
      ).rejects.toThrow(/not allowed for avatar/);

      expect(mockCreateSignedUploadUrl).not.toHaveBeenCalled();
    });
  });

  // ── generateDownloadUrl() ──────────────────
  describe('generateDownloadUrl()', () => {
    it('returns a signed download URL with default expiry of 900s', async () => {
      mockCreateSignedUrl.mockResolvedValue({
        data: { signedUrl: 'https://example.com/download' },
        error: null,
      });

      const result = await generateDownloadUrl('workspaces/ws-1/avatars/file.png');

      expect(result).toEqual({
        download_url: 'https://example.com/download',
        expires_in: 900,
      });
    });

    it('respects a custom expiresIn value', async () => {
      mockCreateSignedUrl.mockResolvedValue({
        data: { signedUrl: 'https://example.com/download' },
        error: null,
      });

      const result = await generateDownloadUrl('some/path.pdf', 3600);

      expect(result.expires_in).toBe(3600);
    });

    it('throws when supabase returns an error', async () => {
      mockCreateSignedUrl.mockResolvedValue({
        data: null,
        error: { message: 'Object not found' },
      });

      await expect(generateDownloadUrl('bad/path')).rejects.toThrow(
        'Storage error: Object not found',
      );
    });
  });

  // ── deleteFile() ───────────────────────────
  describe('deleteFile()', () => {
    it('calls supabase remove with the correct path', async () => {
      mockRemove.mockResolvedValue({ error: null });

      await deleteFile('workspaces/ws-1/avatars/old.png');

      expect(mockRemove).toHaveBeenCalledWith(['workspaces/ws-1/avatars/old.png']);
    });

    it('resolves without a return value on success', async () => {
      mockRemove.mockResolvedValue({ error: null });

      await expect(deleteFile('some/path.png')).resolves.toBeUndefined();
    });

    it('throws when supabase returns a delete error', async () => {
      mockRemove.mockResolvedValue({ error: { message: 'Permission denied' } });

      await expect(deleteFile('protected/file.png')).rejects.toThrow(
        'Storage delete error: Permission denied',
      );
    });
  });
});