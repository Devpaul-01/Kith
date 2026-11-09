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

  describe('bounded metadata reads', () => {
    const C1 = '11111111-1111-4111-8111-111111111111';
    const C2 = '22222222-2222-4222-8222-222222222222';
    const M1 = '33333333-3333-4333-8333-333333333333';
    const M2 = '44444444-4444-4444-8444-444444444444';
    const container = { id: C1, name: 'Family reunion', completed_at: '2026-11-01T12:00:00.000Z', outcome_details: 'A good day' };
    const milestone = { id: M1, title: 'Graduation', milestone_date: '2026-11-02', description: 'Graduated' };

    it('merges metadata with lookahead and advances only the source represented on the page', async () => {
      mockSupabaseInstance.mockResponses({ data: [container], error: null }, { data: [milestone], error: null });
      const result = await milestoneService.getTimeline({ workspaceId: WORKSPACE_ID, limit: 1, metadataOnly: true });
      expect(result).toEqual({ items: [{ type: 'milestone', date: milestone.milestone_date, title: milestone.title, description: milestone.description,
        reference_id: M1, reference_type: 'milestone' }], has_more: true,
      next_cursor: { before_container: null, before_milestone: { date: milestone.milestone_date, id: M1 } } });
      const calls = mockSupabaseInstance.getCalls();
      expect(calls.filter((call) => call.method === 'limit').map((call) => call.args[0])).toEqual([2, 2]);
      expect(calls.filter((call) => call.method === 'select').map((call) => call.args[0]).join(' ')).not.toMatch(/photos|outcome_files|\*|public_token/);
      expect(calls.filter((call) => call.method === 'eq' && call.args[0] === 'workspace_id')).toHaveLength(2);
      expect(calls.filter((call) => call.method === 'is' && call.args[0] === 'deleted_at')).toHaveLength(2);
    });

    it('retains the incoming cursor when a fetched source has no returned item', async () => {
      const cursor = { before_container: { date: '2026-11-09T00:00:00.000Z', id: C2 }, before_milestone: { date: '2026-11-09', id: M2 } };
      mockSupabaseInstance.mockResponses({ data: [container], error: null }, { data: [{ ...milestone, milestone_date: '2026-10-01' }], error: null });
      const result = await milestoneService.getTimeline({ workspaceId: WORKSPACE_ID, limit: 1, cursor, metadataOnly: true });
      expect(result.next_cursor).toEqual({ before_container: { date: container.completed_at, id: C1 }, before_milestone: cursor.before_milestone });
      expect(mockSupabaseInstance.getCalls()).toEqual(expect.arrayContaining([
        { method: 'or', args: [`completed_at.lt.${cursor.before_container.date},and(completed_at.eq.${cursor.before_container.date},id.gt.${C2})`] },
        { method: 'or', args: [`milestone_date.lt.${cursor.before_milestone.date},and(milestone_date.eq.${cursor.before_milestone.date},id.gt.${M2})`] },
      ]));
    });

    it('continues through milestones sharing a date instead of skipping the remaining same-day row', async () => {
      mockSupabaseInstance.mockResponses({ data: [], error: null }, { data: [milestone, { ...milestone, id: M2 }], error: null });
      const first = await milestoneService.getTimeline({ workspaceId: WORKSPACE_ID, limit: 1, metadataOnly: true });
      expect(first.next_cursor.before_milestone).toEqual({ date: milestone.milestone_date, id: M1 });
      mockSupabaseInstance.mockResponses({ data: [], error: null }, { data: [{ ...milestone, id: M2 }], error: null });
      const second = await milestoneService.getTimeline({ workspaceId: WORKSPACE_ID, limit: 1, cursor: first.next_cursor, metadataOnly: true });
      expect(second.items[0].reference_id).toBe(M2);
      expect(second.has_more).toBe(false);
      expect(second.next_cursor).toBeNull();
      expect(mockSupabaseInstance.getCalls()).toContainEqual({ method: 'or', args: [`milestone_date.lt.${milestone.milestone_date},and(milestone_date.eq.${milestone.milestone_date},id.gt.${M1})`] });
    });

    it('preserves database order for completions within the same millisecond', async () => {
      mockSupabaseInstance.mockResponses({ data: [
        { ...container, id: C2, completed_at: '2026-11-01T12:00:00.123900Z' },
        { ...container, id: C1, completed_at: '2026-11-01T12:00:00.123100Z' },
      ], error: null }, { data: [], error: null });
      const result = await milestoneService.getTimeline({ workspaceId: WORKSPACE_ID, limit: 2, metadataOnly: true });
      expect(result.items.map((item) => item.reference_id)).toEqual([C2, C1]);
      expect(result.has_more).toBe(false);
    });

    it('uses deterministic source order at equal instants and preserves the ID cursor for equal completion timestamps', async () => {
      const date = '2026-11-02T00:00:00.000Z';
      mockSupabaseInstance.mockResponses({ data: [{ ...container, completed_at: date }, { ...container, id: C2, completed_at: date }], error: null },
        { data: [milestone], error: null });
      const result = await milestoneService.getTimeline({ workspaceId: WORKSPACE_ID, limit: 1, metadataOnly: true });
      expect(result.items[0].reference_id).toBe(C1);
      expect(result.next_cursor).toEqual({ before_container: { date, id: C1 }, before_milestone: null });
      expect(mockSupabaseInstance.getCalls().filter((call) => call.method === 'order' && call.args[0] === 'id')).toHaveLength(2);
    });

    it('uses lookahead to distinguish an exactly full final page from more results', async () => {
      mockSupabaseInstance.mockResponses({ data: [container], error: null }, { data: [], error: null });
      await expect(milestoneService.getTimeline({ workspaceId: WORKSPACE_ID, limit: 1, metadataOnly: true })).resolves.toMatchObject({ has_more: false, next_cursor: null });
      mockSupabaseInstance.mockResponses({ data: [container, { ...container, id: C2 }], error: null }, { data: [], error: null });
      await expect(milestoneService.getTimeline({ workspaceId: WORKSPACE_ID, limit: 1, metadataOnly: true })).resolves.toHaveProperty('has_more', true);
    });

    it.each([0, 1])('does not return a partial timeline when source %i is unavailable', async (index) => {
      const responses = [{ data: [], error: null }, { data: [], error: null }];
      responses[index] = { data: null, error: { message: 'private database details' } };
      mockSupabaseInstance.mockResponses(...responses);
      await expect(milestoneService.getTimeline({ workspaceId: WORKSPACE_ID, metadataOnly: true })).rejects.toMatchObject({ code: 'TIMELINE_UNAVAILABLE' });
    });

    it('rejects missing source rows and invalid stored dates', async () => {
      mockSupabaseInstance.mockResponses({ data: null, error: null }, { data: [], error: null });
      await expect(milestoneService.getTimeline({ workspaceId: WORKSPACE_ID, metadataOnly: true })).rejects.toMatchObject({ code: 'TIMELINE_UNAVAILABLE' });
      mockSupabaseInstance.mockResponses({ data: [{ ...container, completed_at: null }], error: null }, { data: [], error: null });
      await expect(milestoneService.getTimeline({ workspaceId: WORKSPACE_ID, metadataOnly: true })).rejects.toMatchObject({ code: 'TIMELINE_UNAVAILABLE' });
    });

    it('reads milestone metadata with workspace/deletion scope and excludes file/actor fields', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: M1, title: 'Graduation' }, error: null });
      await milestoneService.getMilestone({ workspaceId: WORKSPACE_ID, milestoneId: M1, metadataOnly: true });
      expect(mockSupabaseInstance.builder.select.mock.calls[0][0]).not.toMatch(/\*|photos|created_by|workspace_id|deleted_at/);
      expect(mockSupabaseInstance.getCalls()).toEqual(expect.arrayContaining([
        { method: 'eq', args: ['id', M1] }, { method: 'eq', args: ['workspace_id', WORKSPACE_ID] }, { method: 'is', args: ['deleted_at', null] },
      ]));
      mockSupabaseInstance.mockNextResponse({ data: null, error: { message: 'private details' } });
      await expect(milestoneService.getMilestone({ workspaceId: WORKSPACE_ID, milestoneId: M1, metadataOnly: true })).rejects.toMatchObject({ code: 'MILESTONES_UNAVAILABLE' });
    });
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
