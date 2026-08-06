// tests/unit/services/milestone.service.test.js
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
jest.mock('../../../src/services/storage.service');

const milestoneService = require('../../../src/services/milestone.service');
const storage = require('../../../src/services/storage.service');
const { NotFoundError } = require('../../../src/utils/errors');
const mockSupabaseInstance = require('../../../src/config/supabase').__mockInstance;

const WORKSPACE_ID = 'ws-1';
const MILESTONE_ID = 'milestone-1';

describe('services/milestone.service', () => {
  beforeEach(() => {
    mockSupabaseInstance.reset();
    jest.clearAllMocks();
  });

  describe('getTimeline — per-source cursor pagination (Issue M11)', () => {
    it('merges completed containers and milestones sorted by date descending', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'c1', name: 'Party', completed_at: '2026-01-05', outcome_details: null, outcome_files: [] }], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'm1', title: 'Birth', milestone_date: '2026-01-10', description: null, photos: [] }], error: null });

      const result = await milestoneService.getTimeline({ workspaceId: WORKSPACE_ID, limit: 50 });

      expect(result.items[0].title).toBe('Birth'); // more recent date first
      expect(result.items[1].title).toBe('Party');
    });

    it('provides independent per-source cursors, not one shared cursor', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'c1', name: 'X', completed_at: '2026-01-01', outcome_details: null, outcome_files: [] }], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'm1', title: 'Y', milestone_date: '2026-02-01', description: null, photos: [] }], error: null });

      const result = await milestoneService.getTimeline({ workspaceId: WORKSPACE_ID, limit: 50 });

      expect(result.next_cursor).toEqual({ before_container: '2026-01-01', before_milestone: '2026-02-01' });
    });

    it('a bare "before" seeds BOTH cursors on first call (back-compat)', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      await milestoneService.getTimeline({ workspaceId: WORKSPACE_ID, limit: 50, before: '2026-01-01' });

      const containerLtCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'lt' && c.args[0] === 'completed_at');
      const milestoneLtCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'lt' && c.args[0] === 'milestone_date');
      expect(containerLtCall.args[1]).toBe('2026-01-01');
      expect(milestoneLtCall.args[1]).toBe('2026-01-01');
    });

    it('explicit per-source cursors take precedence over a stale bare "before"', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      await milestoneService.getTimeline({
        workspaceId: WORKSPACE_ID, limit: 50, before: 'stale', beforeContainer: '2026-03-01', beforeMilestone: '2026-04-01',
      });

      const containerLtCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'lt' && c.args[0] === 'completed_at');
      const milestoneLtCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'lt' && c.args[0] === 'milestone_date');
      expect(containerLtCall.args[1]).toBe('2026-03-01');
      expect(milestoneLtCall.args[1]).toBe('2026-04-01');
    });

    it('has_more is true when either source returns a full page', async () => {
      const fullPage = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, name: 'X', completed_at: '2026-01-01', outcome_details: null, outcome_files: [] }));
      mockSupabaseInstance.mockNextResponse({ data: fullPage, error: null });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      const result = await milestoneService.getTimeline({ workspaceId: WORKSPACE_ID, limit: 5 });

      expect(result.has_more).toBe(true);
    });

    it('clamps limit to a maximum of 100', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      await milestoneService.getTimeline({ workspaceId: WORKSPACE_ID, limit: 500 });

      const limitCalls = mockSupabaseInstance.getCalls().filter((c) => c.method === 'limit');
      limitCalls.forEach((c) => expect(c.args[0]).toBe(100));
    });
  });

  describe('createMilestone / getMilestone', () => {
    it('getMilestone: not found -> NotFoundError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await expect(milestoneService.getMilestone({ workspaceId: WORKSPACE_ID, milestoneId: 'missing' })).rejects.toBeInstanceOf(NotFoundError);
    });

    it('createMilestone succeeds', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: MILESTONE_ID, title: 'Grad' }, error: null });

      const result = await milestoneService.createMilestone({ workspaceId: WORKSPACE_ID, title: 'Grad', milestone_date: '2026-06-01', description: null, milestone_type: 'graduation', actorMemberId: 'm1' });

      expect(result.id).toBe(MILESTONE_ID);
    });
  });

  describe('updateMilestone', () => {
    it('empty diff -> returns current row without an update call', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: MILESTONE_ID, title: 'X' }, error: null });

      const result = await milestoneService.updateMilestone({ workspaceId: WORKSPACE_ID, milestoneId: MILESTONE_ID, data: {} });

      expect(result).toEqual({ id: MILESTONE_ID, title: 'X' });
      expect(mockSupabaseInstance.getCalls().filter((c) => c.method === 'update').length).toBe(0);
    });

    it('milestone not found -> NotFoundError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await expect(
        milestoneService.updateMilestone({ workspaceId: WORKSPACE_ID, milestoneId: 'missing', data: { title: 'New' } })
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('confirmMilestonePhoto', () => {
    it('milestone not found -> NotFoundError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await expect(
        milestoneService.confirmMilestonePhoto({ workspaceId: WORKSPACE_ID, milestoneId: 'missing', filePayload: {}, actorMemberId: 'm1' })
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('propagates a magic-byte mismatch from verifyUploadedFile', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: MILESTONE_ID, photos: [] }, error: null });
      const { BusinessRuleError } = require('../../../src/utils/errors');
      storage.verifyUploadedFile.mockRejectedValueOnce(new BusinessRuleError('mismatch'));

      await expect(
        milestoneService.confirmMilestonePhoto({ workspaceId: WORKSPACE_ID, milestoneId: MILESTONE_ID, filePayload: { file_path: 'p', mime_type: 'image/png' }, actorMemberId: 'm1' })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('success: appends to existing photos array', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: MILESTONE_ID, photos: [{ url: 'existing.png' }] }, error: null });
      storage.verifyUploadedFile.mockResolvedValueOnce(true);
      mockSupabaseInstance.mockNextResponse({ data: { id: MILESTONE_ID, photos: [{ url: 'existing.png' }, { url: 'new.png' }] }, error: null });

      const result = await milestoneService.confirmMilestonePhoto({
        workspaceId: WORKSPACE_ID, milestoneId: MILESTONE_ID,
        filePayload: { file_path: 'new.png', mime_type: 'image/png', name: 'new.png', size: 10 },
        actorMemberId: 'm1',
      });

      expect(result.photos).toHaveLength(2);
    });
  });
});
