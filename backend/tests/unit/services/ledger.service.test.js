// tests/unit/services/ledger.service.test.js
//
// Highest business/financial risk service in the app. createEntry's
// guard chain (idempotency -> contributor resolution -> participant
// lookup -> proxy check -> money-enabled check -> cycle validation ->
// duplicate-window check -> insert -> proxy-action insert ->
// notification -> audit log) is tested per Doc 3 Section 3.6's ~15-case
// matrix.

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

jest.mock('../../../src/config/redis', () => require('../../mocks/redis.mock'));
jest.mock('../../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../../../src/services/notification.service');
jest.mock('../../../src/services/audit.service');
jest.mock('../../../src/services/storage.service');

const ledgerService = require('../../../src/services/ledger.service');
const notification = require('../../../src/services/notification.service');
const audit = require('../../../src/services/audit.service');
const storage = require('../../../src/services/storage.service');
const {
  NotFoundError, BusinessRuleError, ConflictError, ForbiddenError,
} = require('../../../src/utils/errors');
const mockSupabaseInstance = require('../../../src/config/supabase').__mockInstance;

const WORKSPACE_ID = 'ws-1';
const CONTAINER_ID = 'container-1';
const CALLER_ID = 'member-caller';
const ACTOR_CTX = { workspaceId: WORKSPACE_ID, actorUserId: 'user-1', actorMemberId: CALLER_ID };

const validParticipant = { id: 'p1', workspace_member_id: CALLER_ID, money_enabled: true };
const nonProxyMember = { is_proxy: false };
const proxyMember = { is_proxy: true };

const baseEntryData = {
  entry_type: 'contribution',
  original_amount: 50,
  original_currency: 'USD',
  base_amount: 50,
};

describe('services/ledger.service', () => {
  beforeEach(() => {
    mockSupabaseInstance.reset();
    jest.clearAllMocks();
    notification.send.mockResolvedValue();
    audit.log.mockResolvedValue();
  });

  describe('createEntry', () => {
    it('1. idempotency key match on an existing entry -> returns existing entry, idempotent:true, no new insert', async () => {
      const existingEntry = { id: 'existing-1', status: 'confirmed' };
      mockSupabaseInstance.mockNextResponse({ data: existingEntry, error: null }); // idempotency lookup

      const result = await ledgerService.createEntry({
        workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, data: baseEntryData,
        isAdmin: false, callerId: CALLER_ID, force: false, idempotencyKey: 'idem-key-1',
        actorDisplayName: 'Bob', actorCtx: ACTOR_CTX,
      });

      expect(result).toEqual({ entry: existingEntry, idempotent: true });
      const insertCalls = mockSupabaseInstance.getCalls().filter((c) => c.method === 'insert');
      expect(insertCalls.length).toBe(0);
    });

    it('2. idempotency key present but no match -> proceeds to create normally', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null }); // idempotency lookup: no match
      mockSupabaseInstance.mockNextResponse({ data: validParticipant, error: null }); // participant lookup
      mockSupabaseInstance.mockNextResponse({ data: nonProxyMember, error: null }); // member lookup
      mockSupabaseInstance.mockNextResponse({ data: { id: 'entry-new' }, error: null }); // insert

      const result = await ledgerService.createEntry({
        workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID,
        data: { ...baseEntryData, contributor_id: CALLER_ID },
        isAdmin: true, callerId: CALLER_ID, force: false, idempotencyKey: 'idem-key-2',
        actorDisplayName: 'Bob', actorCtx: ACTOR_CTX,
      });

      expect(result.idempotent).toBe(false);
      expect(result.entry.id).toBe('entry-new');
    });

    it('3. IDEMPOTENCY_ENABLED=false override: key accepted but ignored, no idempotency lookup performed', async () => {
      jest.resetModules();
      process.env.IDEMPOTENCY_ENABLED = 'false';

      jest.doMock('../../../src/config/supabase', () => {
        const { mockSupabase: createMock } = require('../../mocks/supabase.mock');
        const instance = createMock();
        return {
          supabaseAdmin: instance.client,
          supabase: instance.client,
          supabaseAuth: instance.client,
          __mockInstance: instance,
        };
      });
      jest.doMock('../../../src/config/redis', () => require('../../mocks/redis.mock'));
      jest.doMock('../../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
      jest.doMock('../../../src/services/notification.service');
      jest.doMock('../../../src/services/audit.service');
      jest.doMock('../../../src/services/storage.service');

      const freshLedgerService = require('../../../src/services/ledger.service');
      const freshAudit = require('../../../src/services/audit.service');
      freshAudit.log.mockResolvedValue();
      const freshSupabaseInstance = require('../../../src/config/supabase').__mockInstance;

      freshSupabaseInstance.mockNextResponse({ data: validParticipant, error: null }); // participant lookup (no idempotency lookup first)
      freshSupabaseInstance.mockNextResponse({ data: nonProxyMember, error: null }); // member lookup
      // No idempotency key (or disabled): createEntry goes through the
      // create_ledger_entry_checked RPC, which does the duplicate-window
      // check and the insert atomically under an advisory lock. See
      // migrations/004_fix_ledger_entry_duplicate_check_race.sql.
      freshSupabaseInstance.mockNextRpcResponse({ data: { duplicate: false, entry: { id: 'entry-x' } }, error: null });

      await freshLedgerService.createEntry({
        workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID,
        data: { ...baseEntryData, contributor_id: CALLER_ID },
        isAdmin: true, callerId: CALLER_ID, force: false, idempotencyKey: 'ignored-key',
        actorDisplayName: 'Bob', actorCtx: ACTOR_CTX,
      });

      const idemLookupCalls = freshSupabaseInstance.getCalls().filter((c) => c.method === 'eq' && c.args[0] === 'idempotency_key');
      expect(idemLookupCalls.length).toBe(0);

      delete process.env.IDEMPOTENCY_ENABLED;
      jest.resetModules();
    });

    it('4a. non-admin omitting contributor_id -> defaults to self (callerId)', async () => {
      mockSupabaseInstance.mockNextResponse({ data: validParticipant, error: null }); // participant lookup
      mockSupabaseInstance.mockNextResponse({ data: nonProxyMember, error: null });
      mockSupabaseInstance.mockNextRpcResponse({ data: { duplicate: false, entry: { id: 'entry-1', contributor_id: CALLER_ID } }, error: null });

      await ledgerService.createEntry({
        workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, data: baseEntryData,
        isAdmin: false, callerId: CALLER_ID, force: false, idempotencyKey: null,
        actorDisplayName: 'Bob', actorCtx: ACTOR_CTX,
      });

      const participantEq = mockSupabaseInstance.getCalls().find(
        (c) => c.method === 'eq' && c.args[0] === 'workspace_member_id'
      );
      expect(participantEq.args[1]).toBe(CALLER_ID);
    });

    it('4b. admin omitting contributor_id -> BusinessRuleError', async () => {
      await expect(
        ledgerService.createEntry({
          workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, data: baseEntryData,
          isAdmin: true, callerId: CALLER_ID, force: false, idempotencyKey: null,
          actorDisplayName: 'Bob', actorCtx: ACTOR_CTX,
        })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('5. contributor_id not a participant -> BusinessRuleError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null }); // participant lookup: not found

      await expect(
        ledgerService.createEntry({
          workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID,
          data: { ...baseEntryData, contributor_id: 'not-a-participant' },
          isAdmin: true, callerId: CALLER_ID, force: false, idempotencyKey: null,
          actorDisplayName: 'Bob', actorCtx: ACTOR_CTX,
        })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('6a. proxy contributor, non-admin caller -> ForbiddenError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: validParticipant, error: null });
      mockSupabaseInstance.mockNextResponse({ data: proxyMember, error: null });

      await expect(
        ledgerService.createEntry({
          workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, data: baseEntryData,
          isAdmin: false, callerId: CALLER_ID, force: false, idempotencyKey: null,
          actorDisplayName: 'Bob', actorCtx: ACTOR_CTX,
        })
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('6b. proxy contributor, admin caller -> succeeds and inserts a proxy_actions audit row', async () => {
      mockSupabaseInstance.mockNextResponse({ data: validParticipant, error: null });
      mockSupabaseInstance.mockNextResponse({ data: proxyMember, error: null });
      mockSupabaseInstance.mockNextRpcResponse({ data: { duplicate: false, entry: { id: 'entry-proxy' } }, error: null }); // check+insert entry
      mockSupabaseInstance.mockNextResponse({ data: null, error: null }); // proxy_actions insert

      await ledgerService.createEntry({
        workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID,
        data: { ...baseEntryData, contributor_id: CALLER_ID },
        isAdmin: true, callerId: 'admin-1', force: false, idempotencyKey: null,
        actorDisplayName: 'Admin', actorCtx: ACTOR_CTX,
      });

      const proxyInsert = mockSupabaseInstance.getCalls().find(
        (c) => c.method === 'from' && c.args[0] === 'proxy_actions'
      );
      expect(proxyInsert).toBeDefined();
    });

    it('7. money_enabled:false on the participant -> BusinessRuleError with a specific message', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { ...validParticipant, money_enabled: false }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: nonProxyMember, error: null });

      await expect(
        ledgerService.createEntry({
          workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, data: baseEntryData,
          isAdmin: false, callerId: CALLER_ID, force: false, idempotencyKey: null,
          actorDisplayName: 'Bob', actorCtx: ACTOR_CTX,
        })
      ).rejects.toThrow('Money tracking is not enabled for this participant');
    });

    it('8. cycle_id not belonging to this container -> BusinessRuleError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: validParticipant, error: null });
      mockSupabaseInstance.mockNextResponse({ data: nonProxyMember, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null }); // cycle lookup: not found

      await expect(
        ledgerService.createEntry({
          workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID,
          data: { ...baseEntryData, cycle_id: 'foreign-cycle' },
          isAdmin: false, callerId: CALLER_ID, force: false, idempotencyKey: null,
          actorDisplayName: 'Bob', actorCtx: ACTOR_CTX,
        })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('9a. duplicate-window hit, no force/idempotency -> ConflictError with existing_entry_id', async () => {
      mockSupabaseInstance.mockNextResponse({ data: validParticipant, error: null });
      mockSupabaseInstance.mockNextResponse({ data: nonProxyMember, error: null });
      // The duplicate-window check and the insert happen atomically inside
      // create_ledger_entry_checked (under a pg_advisory_xact_lock keyed on
      // container_id+contributor_id), so a hit is reported as a single RPC
      // result rather than a separate SELECT response. See
      // migrations/004_fix_ledger_entry_duplicate_check_race.sql.
      mockSupabaseInstance.mockNextRpcResponse({ data: { duplicate: true, existing_entry_id: 'dup-entry-1' }, error: null });

      let caught;
      try {
        await ledgerService.createEntry({
          workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, data: baseEntryData,
          isAdmin: false, callerId: CALLER_ID, force: false, idempotencyKey: null,
          actorDisplayName: 'Bob', actorCtx: ACTOR_CTX,
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ConflictError);
      expect(caught.details).toEqual({ existing_entry_id: 'dup-entry-1' });
    });

    it('9b. force=true bypasses the duplicate-window check', async () => {
      mockSupabaseInstance.mockNextResponse({ data: validParticipant, error: null });
      mockSupabaseInstance.mockNextResponse({ data: nonProxyMember, error: null });
      mockSupabaseInstance.mockNextRpcResponse({ data: { duplicate: false, entry: { id: 'entry-forced' } }, error: null });

      await ledgerService.createEntry({
        workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, data: baseEntryData,
        isAdmin: false, callerId: CALLER_ID, force: true, idempotencyKey: null,
        actorDisplayName: 'Bob', actorCtx: ACTOR_CTX,
      });

      // force=true is passed through as p_force: true, so
      // create_ledger_entry_checked skips its internal duplicate check
      // entirely — assert the RPC was called with the force flag set,
      // rather than asserting the absence of a separate .gte() call
      // (there no longer is one on this path).
      const rpcCall = mockSupabaseInstance.getRpcCalls().find((c) => c.fnName === 'create_ledger_entry_checked');
      expect(rpcCall.params.p_force).toBe(true);
    });

    it('10a. admin-created entry -> status confirmed immediately, no admin notification sent', async () => {
      mockSupabaseInstance.mockNextResponse({ data: validParticipant, error: null });
      mockSupabaseInstance.mockNextResponse({ data: nonProxyMember, error: null });
      mockSupabaseInstance.mockNextRpcResponse({ data: { duplicate: false, entry: { id: 'entry-admin', status: 'confirmed' } }, error: null });

      await ledgerService.createEntry({
        workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID,
        data: { ...baseEntryData, contributor_id: CALLER_ID },
        isAdmin: true, callerId: 'admin-1', force: false, idempotencyKey: null,
        actorDisplayName: 'Admin', actorCtx: ACTOR_CTX,
      });

      const rpcCall = mockSupabaseInstance.getRpcCalls().find((c) => c.fnName === 'create_ledger_entry_checked');
      expect(rpcCall.params.p_status).toBe('confirmed');
      expect(notification.send).not.toHaveBeenCalled();
    });

    it('10b. non-admin-created entry -> status pending, admins notified', async () => {
      mockSupabaseInstance.mockNextResponse({ data: validParticipant, error: null });
      mockSupabaseInstance.mockNextResponse({ data: nonProxyMember, error: null });
      mockSupabaseInstance.mockNextRpcResponse({ data: { duplicate: false, entry: { id: 'entry-pending', status: 'pending' } }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'admin-1' }], error: null }); // admins lookup

      await ledgerService.createEntry({
        workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, data: baseEntryData,
        isAdmin: false, callerId: CALLER_ID, force: false, idempotencyKey: null,
        actorDisplayName: 'Bob', actorCtx: ACTOR_CTX,
      });

      expect(notification.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'contribution_submitted',
        recipientIds: ['admin-1'],
      }));
    });

    it('11a. resulting status confirmed -> audit action is LEDGER_CONFIRMED', async () => {
      mockSupabaseInstance.mockNextResponse({ data: validParticipant, error: null });
      mockSupabaseInstance.mockNextResponse({ data: nonProxyMember, error: null });
      mockSupabaseInstance.mockNextRpcResponse({ data: { duplicate: false, entry: { id: 'entry-1', status: 'confirmed' } }, error: null });

      await ledgerService.createEntry({
        workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID,
        data: { ...baseEntryData, contributor_id: CALLER_ID },
        isAdmin: true, callerId: 'admin-1', force: false, idempotencyKey: null,
        actorDisplayName: 'Admin', actorCtx: ACTOR_CTX,
      });

      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'ledger.confirmed' }));
    });

    it('11b. resulting status pending -> audit action is LEDGER_SUBMITTED', async () => {
      mockSupabaseInstance.mockNextResponse({ data: validParticipant, error: null });
      mockSupabaseInstance.mockNextResponse({ data: nonProxyMember, error: null });
      mockSupabaseInstance.mockNextRpcResponse({ data: { duplicate: false, entry: { id: 'entry-2', status: 'pending' } }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null }); // admins lookup (empty, no notif needed but still queried)

      await ledgerService.createEntry({
        workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, data: baseEntryData,
        isAdmin: false, callerId: CALLER_ID, force: false, idempotencyKey: null,
        actorDisplayName: 'Bob', actorCtx: ACTOR_CTX,
      });

      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'ledger.submitted' }));
    });

    it('idempotency-lookup DB error is fail-loud (throws), not silently ignored', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: { message: 'connection lost' } });

      await expect(
        ledgerService.createEntry({
          workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, data: baseEntryData,
          isAdmin: false, callerId: CALLER_ID, force: false, idempotencyKey: 'key-err',
          actorDisplayName: 'Bob', actorCtx: ACTOR_CTX,
        })
      ).rejects.toThrow('connection lost');
    });
  });

  describe('updateEntry', () => {
    it('only pending entries can be edited', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'e1', status: 'confirmed', contributor_id: CALLER_ID }, error: null });

      await expect(
        ledgerService.updateEntry({ containerId: CONTAINER_ID, entryId: 'e1', data: { note: 'x' }, isAdmin: false, callerId: CALLER_ID })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('non-owner non-admin cannot edit -> ForbiddenError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'e1', status: 'pending', contributor_id: 'someone-else' }, error: null });

      await expect(
        ledgerService.updateEntry({ containerId: CONTAINER_ID, entryId: 'e1', data: { note: 'x' }, isAdmin: false, callerId: CALLER_ID })
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('non-admin attempting to change contributor_id -> ForbiddenError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'e1', status: 'pending', contributor_id: CALLER_ID }, error: null });

      await expect(
        ledgerService.updateEntry({ containerId: CONTAINER_ID, entryId: 'e1', data: { contributor_id: 'x' }, isAdmin: false, callerId: CALLER_ID })
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('entry not found -> NotFoundError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await expect(
        ledgerService.updateEntry({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, entryId: 'missing', data: {}, isAdmin: true, callerId: CALLER_ID })
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('REGRESSION: admin reassigning contributor_id to a non-participant -> BusinessRuleError, not silently accepted', async () => {
      // Previously updateEntry only validated contributor_id as a
      // well-formed UUID (via Zod) — this reassignment ran NO
      // participant/money_enabled/proxy check at all, unlike createEntry.
      mockSupabaseInstance.mockNextResponse({ data: { id: 'e1', status: 'pending', contributor_id: CALLER_ID }, error: null }); // entry fetch
      mockSupabaseInstance.mockNextResponse({ data: null, error: null }); // container_participants lookup: not a participant

      await expect(
        ledgerService.updateEntry({
          workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, entryId: 'e1',
          data: { contributor_id: 'not-a-participant' }, isAdmin: true, callerId: 'admin-1',
        })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('REGRESSION: admin reassigning contributor_id to a participant with money_enabled: false -> BusinessRuleError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'e1', status: 'pending', contributor_id: CALLER_ID }, error: null }); // entry fetch
      mockSupabaseInstance.mockNextResponse({ data: { id: 'p2', workspace_member_id: 'member-2', money_enabled: false }, error: null }); // participant lookup
      mockSupabaseInstance.mockNextResponse({ data: nonProxyMember, error: null }); // member lookup

      await expect(
        ledgerService.updateEntry({
          workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, entryId: 'e1',
          data: { contributor_id: 'member-2' }, isAdmin: true, callerId: 'admin-1',
        })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('admin reassigning contributor_id to a different, valid money-enabled participant -> succeeds', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'e1', status: 'pending', contributor_id: CALLER_ID }, error: null }); // entry fetch (original contributor: CALLER_ID)
      mockSupabaseInstance.mockNextResponse({ data: validParticipant, error: null }); // participant lookup for the NEW contributor
      mockSupabaseInstance.mockNextResponse({ data: nonProxyMember, error: null }); // member lookup
      mockSupabaseInstance.mockNextResponse({ data: { id: 'e1', contributor_id: 'member-2' }, error: null }); // update

      await expect(
        ledgerService.updateEntry({
          workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, entryId: 'e1',
          data: { contributor_id: 'member-2' }, isAdmin: true, callerId: 'admin-1',
        })
      ).resolves.toEqual({ id: 'e1', contributor_id: 'member-2' });
    });

    it('reassigning contributor_id to the SAME contributor does not re-run the participant validation query', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'e1', status: 'pending', contributor_id: CALLER_ID }, error: null }); // entry fetch
      mockSupabaseInstance.mockNextResponse({ data: { id: 'e1', note: 'x' }, error: null }); // update (no participant lookup in between)

      await expect(
        ledgerService.updateEntry({
          workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, entryId: 'e1',
          data: { contributor_id: CALLER_ID, note: 'x' }, isAdmin: true, callerId: 'admin-1',
        })
      ).resolves.toEqual({ id: 'e1', note: 'x' });
    });
  });

  describe('deleteEntry', () => {
    it('only pending/proof_uploaded entries can be deleted', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'e1', status: 'confirmed', contributor_id: CALLER_ID }, error: null });

      await expect(
        ledgerService.deleteEntry({ containerId: CONTAINER_ID, entryId: 'e1', isAdmin: false, callerId: CALLER_ID, actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('non-owner non-admin cannot delete -> ForbiddenError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'e1', status: 'pending', contributor_id: 'someone-else' }, error: null });

      await expect(
        ledgerService.deleteEntry({ containerId: CONTAINER_ID, entryId: 'e1', isAdmin: false, callerId: CALLER_ID, actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('success: deletes and writes an audit log entry', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'e1', status: 'pending', contributor_id: CALLER_ID }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null }); // delete

      await ledgerService.deleteEntry({ containerId: CONTAINER_ID, entryId: 'e1', isAdmin: false, callerId: CALLER_ID, actorCtx: ACTOR_CTX });

      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'ledger.deleted' }));
    });
  });

  describe('getLedgerSummary', () => {
    it('correctly sums confirmed/pending/disputed counts and totals', async () => {
      mockSupabaseInstance.mockNextResponse({
        data: [
          { status: 'confirmed', base_amount: 100 },
          { status: 'confirmed', base_amount: 50 },
          { status: 'pending', base_amount: 25 },
          { status: 'proof_uploaded', base_amount: 10 },
          { status: 'disputed', base_amount: 5 },
        ],
        error: null,
      });

      const result = await ledgerService.getLedgerSummary({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, isAdmin: true, callerId: CALLER_ID });

      expect(result).toEqual({
        confirmed_count: 2,
        confirmed_base_total: 150,
        pending_count: 2,
        pending_base_total: 35,
        disputed_count: 1,
        disputed_base_total: 5,
        total_count: 5,
        total_base_amount: 190,
      });
    });

    it('handles zero entries without error (all-zero shape)', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      const result = await ledgerService.getLedgerSummary({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, isAdmin: true, callerId: CALLER_ID });

      expect(result.total_count).toBe(0);
      expect(result.total_base_amount).toBe(0);
    });

    it('REGRESSION: a resolved (disputed-then-resolved) entry counts toward confirmed_count/confirmed_base_total, not just status === confirmed', async () => {
      // A dispute that is raised and then resolved moves the entry to a
      // third terminal status, 'resolved' — distinct from 'confirmed'.
      // It is still money the contributor has credit for and must be
      // included in the confirmed bucket, or it silently disappears from
      // every "money received" total in the app.
      mockSupabaseInstance.mockNextResponse({
        data: [
          { status: 'confirmed', base_amount: 100 },
          { status: 'resolved',  base_amount: 40 },
          { status: 'disputed',  base_amount: 5 },
        ],
        error: null,
      });

      const result = await ledgerService.getLedgerSummary({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, isAdmin: true, callerId: CALLER_ID });

      expect(result.confirmed_count).toBe(2);
      expect(result.confirmed_base_total).toBe(140);
      // 'resolved' is a paid status, not a disputed one, even though it
      // originated from a dispute — only the still-open dispute counts here.
      expect(result.disputed_count).toBe(1);
      expect(result.disputed_base_total).toBe(5);
    });
  });

  describe('addCorrection', () => {
    it('rejects correcting a non-confirmed entry', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'e1', status: 'pending', contributor_id: CALLER_ID }, error: null });

      await expect(
        ledgerService.addCorrection({
          workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, entryId: 'e1',
          data: { original_amount: 10, original_currency: 'USD', base_amount: 10, note: 'fix' },
          actorMemberId: 'admin-1', actorCtx: ACTOR_CTX,
        })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('rejects when the participant no longer has money_enabled', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'e1', status: 'confirmed', contributor_id: CALLER_ID }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { money_enabled: false }, error: null });

      await expect(
        ledgerService.addCorrection({
          workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, entryId: 'e1',
          data: { original_amount: 10, original_currency: 'USD', base_amount: 10, note: 'fix' },
          actorMemberId: 'admin-1', actorCtx: ACTOR_CTX,
        })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('success: inserts a correction entry and audits with the correction_entry_id in metadata', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'e1', status: 'confirmed', contributor_id: CALLER_ID }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { money_enabled: true }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: 'correction-1' }, error: null });

      const result = await ledgerService.addCorrection({
        workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, entryId: 'e1',
        data: { original_amount: 10, original_currency: 'USD', base_amount: 10, note: 'fix' },
        actorMemberId: 'admin-1', actorCtx: ACTOR_CTX,
      });

      expect(result.id).toBe('correction-1');
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
        metadata: { correction_entry_id: 'correction-1' },
      }));
    });
  });

  describe('deleteProof', () => {
    it('rejects a negative proofIndex', async () => {
      await expect(
        ledgerService.deleteProof({ containerId: CONTAINER_ID, entryId: 'e1', proofIndex: -1, isAdmin: true, callerId: CALLER_ID })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('non-admin cannot remove a proof from a confirmed entry', async () => {
      mockSupabaseInstance.mockNextResponse({
        data: { contributor_id: CALLER_ID, proofs: [{ url: 'x' }], status: 'confirmed' },
        error: null,
      });

      await expect(
        ledgerService.deleteProof({ containerId: CONTAINER_ID, entryId: 'e1', proofIndex: 0, isAdmin: false, callerId: CALLER_ID })
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('out-of-range proofIndex -> NotFoundError', async () => {
      mockSupabaseInstance.mockNextResponse({
        data: { contributor_id: CALLER_ID, proofs: [{ url: 'x' }], status: 'pending' },
        error: null,
      });

      await expect(
        ledgerService.deleteProof({ containerId: CONTAINER_ID, entryId: 'e1', proofIndex: 5, isAdmin: false, callerId: CALLER_ID })
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('confirmProof', () => {
    it('propagates a magic-byte mismatch from storage.verifyUploadedFile without advancing status', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'e1', contributor_id: CALLER_ID, status: 'pending', proofs: [] }, error: null });
      storage.verifyUploadedFile.mockRejectedValueOnce(new BusinessRuleError('type mismatch'));

      await expect(
        ledgerService.confirmProof({
          workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, entryId: 'e1',
          isAdmin: false, callerId: CALLER_ID,
          filePayload: { file_path: 'p', mime_type: 'image/png', name: 'a.png', size: 10 },
          actorDisplayName: 'Bob',
        })
      ).rejects.toBeInstanceOf(BusinessRuleError);

      const updateCalls = mockSupabaseInstance.getCalls().filter((c) => c.method === 'update');
      expect(updateCalls.length).toBe(0);
    });

    it('successful confirm on pending -> proof_uploaded status', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'e1', contributor_id: CALLER_ID, status: 'pending', proofs: [] }, error: null });
      storage.verifyUploadedFile.mockResolvedValueOnce(true);
      mockSupabaseInstance.mockNextResponse({ data: { id: 'e1', status: 'proof_uploaded' }, error: null }); // update
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'admin-1' }], error: null }); // admins

      const result = await ledgerService.confirmProof({
        workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, entryId: 'e1',
        isAdmin: false, callerId: CALLER_ID,
        filePayload: { file_path: 'p', mime_type: 'image/png', name: 'a.png', size: 10 },
        actorDisplayName: 'Bob',
      });

      expect(result.status).toBe('proof_uploaded');
    });
  });

  describe('confirmEntry', () => {
    it('only pending/proof_uploaded entries can be confirmed', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'e1', status: 'disputed' }, error: null });

      await expect(
        ledgerService.confirmEntry({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, entryId: 'e1', actorMemberId: 'admin-1', actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });
  });

  // ── listEntries ────────────────────────────────────────────────────
  //
  // Previously untested despite being the primary read path every ledger
  // UI screen hits. Covers the admin/non-admin visibility split (the
  // single most important access-control branch in this function), the
  // joined-name reshaping, query filters, and the fail-loud error path.
  describe('listEntries', () => {
    it('non-admin caller is scoped to their own contributor_id regardless of query filters', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null, count: 0 });

      await ledgerService.listEntries({
        workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID,
        isAdmin: false, callerId: CALLER_ID,
        query: { contributor_id: 'someone-else' }, // a non-admin trying to view another member's entries
        page: 1, perPage: 20, offset: 0,
      });

      const eqCalls = mockSupabaseInstance.builder.eq.mock.calls;
      expect(eqCalls).toContainEqual(['contributor_id', CALLER_ID]);
      expect(eqCalls).not.toContainEqual(['contributor_id', 'someone-else']);
    });

    it('admin caller may filter by an explicit contributor_id', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null, count: 0 });

      await ledgerService.listEntries({
        workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID,
        isAdmin: true, callerId: CALLER_ID,
        query: { contributor_id: 'target-member' },
        page: 1, perPage: 20, offset: 0,
      });

      expect(mockSupabaseInstance.builder.eq.mock.calls).toContainEqual(['contributor_id', 'target-member']);
    });

    it('admin caller with no contributor_id filter sees the whole container (no contributor_id eq applied)', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null, count: 0 });

      await ledgerService.listEntries({
        workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID,
        isAdmin: true, callerId: CALLER_ID,
        query: {}, page: 1, perPage: 20, offset: 0,
      });

      const contributorEqCalls = mockSupabaseInstance.builder.eq.mock.calls.filter((c) => c[0] === 'contributor_id');
      expect(contributorEqCalls).toHaveLength(0);
    });

    it('applies status and date-range filters when present in query', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null, count: 0 });

      await ledgerService.listEntries({
        workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID,
        isAdmin: true, callerId: CALLER_ID,
        query: { status: 'confirmed', from: '2026-01-01', to: '2026-02-01' },
        page: 1, perPage: 20, offset: 0,
      });

      expect(mockSupabaseInstance.builder.eq.mock.calls).toContainEqual(['status', 'confirmed']);
      expect(mockSupabaseInstance.builder.gte.mock.calls).toContainEqual(['recorded_at', '2026-01-01']);
      expect(mockSupabaseInstance.builder.lte.mock.calls).toContainEqual(['recorded_at', '2026-02-01']);
    });

    it('reshapes joined contributor/recorder/confirmer rows into flat *_name fields and strips the nested objects', async () => {
      mockSupabaseInstance.mockNextResponse({
        data: [{
          id: 'e1',
          contributor: { display_name: 'Alice' },
          recorded_by_member: { display_name: 'Bob' },
          confirmed_by_member: { display_name: 'Carol' },
        }],
        error: null,
        count: 1,
      });

      const { entries, count } = await ledgerService.listEntries({
        workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID,
        isAdmin: true, callerId: CALLER_ID,
        query: {}, page: 1, perPage: 20, offset: 0,
      });

      expect(count).toBe(1);
      expect(entries[0]).toMatchObject({
        id: 'e1',
        contributor_name: 'Alice',
        recorded_by_name: 'Bob',
        confirmed_by_name: 'Carol',
      });
      expect(entries[0].contributor).toBeUndefined();
      expect(entries[0].recorded_by_member).toBeUndefined();
      expect(entries[0].confirmed_by_member).toBeUndefined();
    });

    it('a null count from Postgres is normalized to 0, not passed through as null', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null, count: null });

      const { count } = await ledgerService.listEntries({
        workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID,
        isAdmin: true, callerId: CALLER_ID,
        query: {}, page: 1, perPage: 20, offset: 0,
      });

      expect(count).toBe(0);
    });

    it('query error is fail-loud (throws rather than returning an empty page)', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: { message: 'relation does not exist' } });

      await expect(
        ledgerService.listEntries({
          workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID,
          isAdmin: true, callerId: CALLER_ID,
          query: {}, page: 1, perPage: 20, offset: 0,
        })
      ).rejects.toThrow('relation does not exist');
    });
  });

  // ── getEntry ──────────────────────────────────────────────────────
  //
  // Single-entry read, gated by the same admin/owner access rule as
  // every mutating ledger endpoint — but previously the only ledger
  // service function with that rule that had no direct test.
  describe('getEntry', () => {
    it('returns the reshaped entry for its own contributor (non-admin)', async () => {
      mockSupabaseInstance.mockNextResponse({
        data: {
          id: 'e1',
          contributor_id: CALLER_ID,
          contributor: { display_name: 'Alice' },
          recorded_by_member: null,
          confirmed_by_member: null,
        },
        error: null,
      });

      const entry = await ledgerService.getEntry({
        containerId: CONTAINER_ID, entryId: 'e1', isAdmin: false, callerId: CALLER_ID,
      });

      expect(entry.id).toBe('e1');
      expect(entry.contributor_name).toBe('Alice');
      expect(entry.contributor).toBeUndefined();
    });

    it('non-admin requesting a DIFFERENT contributor\'s entry is rejected with ForbiddenError', async () => {
      mockSupabaseInstance.mockNextResponse({
        data: { id: 'e1', contributor_id: 'someone-else', contributor: null },
        error: null,
      });

      await expect(
        ledgerService.getEntry({ containerId: CONTAINER_ID, entryId: 'e1', isAdmin: false, callerId: CALLER_ID })
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('admin may read any contributor\'s entry', async () => {
      mockSupabaseInstance.mockNextResponse({
        data: { id: 'e1', contributor_id: 'someone-else', contributor: null },
        error: null,
      });

      const entry = await ledgerService.getEntry({
        containerId: CONTAINER_ID, entryId: 'e1', isAdmin: true, callerId: CALLER_ID,
      });

      expect(entry.id).toBe('e1');
    });

    it('non-existent entry -> NotFoundError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await expect(
        ledgerService.getEntry({ containerId: CONTAINER_ID, entryId: 'missing', isAdmin: true, callerId: CALLER_ID })
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('query error is fail-loud (throws)', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: { message: 'connection reset' } });

      await expect(
        ledgerService.getEntry({ containerId: CONTAINER_ID, entryId: 'e1', isAdmin: true, callerId: CALLER_ID })
      ).rejects.toThrow('connection reset');
    });
  });
});
