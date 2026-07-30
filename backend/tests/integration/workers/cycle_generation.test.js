// tests/integration/workers/cycle_generation.test.js
//
// Doc 3 Section 5.2 — cycle_generation.service.js (generateCycles).
// Per Doc 3 Section 5's recommendation, business-logic cases call the
// service function directly (fast); the dedicated concurrency race test
// (Doc 1 Bug Review Finding 9) uses the REAL Queue+Worker
// (tests/integration/workers's "wiring smoke test" category, Section
// 5.11) since the race is specifically about BullMQ's concurrency: 5
// setting on createCycleGenerationWorker.

const crypto = require('crypto');
const { generateCycles } = require('../../../src/services/cycle_generation.service');
const { supabaseAdmin } = require('../../../src/config/supabase');
const { getQueue } = require('../../../src/queues');
const { createCycleGenerationWorker } = require('../../../src/workers/background.workers');
const { seedWorkspaceWithAdmin, seedAdditionalMember, cleanupWorkspace } = require('../../helpers/dbHelper');
const { buildRecurringContainer, buildContainer } = require('../../fixtures/factories');
const { freezeTime, unfreezeTime } = require('../../helpers/timeHelper');

describe('cycle_generation.service.js — generateCycles', () => {
  const seededWorkspaceIds = [];

  afterAll(async () => {
    for (const id of seededWorkspaceIds) {
      await cleanupWorkspace(supabaseAdmin, id).catch(() => {});
    }
  });

  afterEach(() => {
    unfreezeTime();
  });

  async function seedRecurringContainer(overrides = {}) {
    const { workspace, member } = await seedWorkspaceWithAdmin(supabaseAdmin);
    seededWorkspaceIds.push(workspace.id);
    const container = buildRecurringContainer({ workspace_id: workspace.id, created_by: member.id, status: 'active', ...overrides });
    await supabaseAdmin.from('containers').insert(container);
    return { workspace, member, container };
  }

  it('container not found / not recurring / not active -> early return, no cycles created (all three independently)', async () => {
    const { container: recurringButInactive } = await seedRecurringContainer({ status: 'archived' });
    await generateCycles({ container_id: recurringButInactive.id });
    const { count: c1 } = await supabaseAdmin.from('container_cycles').select('*', { count: 'exact', head: true }).eq('container_id', recurringButInactive.id);
    expect(c1).toBe(0);

    const { workspace, member } = await seedWorkspaceWithAdmin(supabaseAdmin);
    seededWorkspaceIds.push(workspace.id);
    const eventContainer = buildContainer({ workspace_id: workspace.id, created_by: member.id, container_type: 'event', status: 'active' });
    await supabaseAdmin.from('containers').insert(eventContainer);
    await generateCycles({ container_id: eventContainer.id });
    const { count: c2 } = await supabaseAdmin.from('container_cycles').select('*', { count: 'exact', head: true }).eq('container_id', eventContainer.id);
    expect(c2).toBe(0);

    await generateCycles({ container_id: crypto.randomUUID() }); // not found — must not throw
  });

  it('first-ever generation starts from recurrence_start, cycle_number: 1', async () => {
    freezeTime('2026-01-15T00:00:00Z');
    const { container } = await seedRecurringContainer({ recurrence_start: '2026-01-01', recurrence_cadence: 'monthly' });

    await generateCycles({ container_id: container.id, generate_months_ahead: 1 });

    const { data: cycles } = await supabaseAdmin.from('container_cycles').select('*').eq('container_id', container.id).order('cycle_number');
    expect(cycles[0].cycle_number).toBe(1);
    expect(cycles[0].cycle_start).toBe('2026-01-01');
  });

  it('monthly cadence starting on the 31st correctly rolls over month lengths across a multi-cycle sequential run', async () => {
    freezeTime('2026-01-31T00:00:00Z');
    const { container } = await seedRecurringContainer({ recurrence_start: '2026-01-31', recurrence_cadence: 'monthly' });

    await generateCycles({ container_id: container.id, generate_months_ahead: 4 });

    const { data: cycles } = await supabaseAdmin.from('container_cycles').select('*').eq('container_id', container.id).order('cycle_number');
    expect(cycles.length).toBeGreaterThanOrEqual(2);
    // Each subsequent cycle_start must be strictly after the previous
    // cycle_end, with no gap/overlap regressions from JS Date.setMonth's
    // known day-of-month rollover quirks (e.g. Jan 31 + 1 month naively
    // could roll into March instead of Feb 28/29 in a buggy implementation).
    for (let i = 1; i < cycles.length; i++) {
      const prevEnd = new Date(cycles[i - 1].cycle_end);
      const thisStart = new Date(cycles[i].cycle_start);
      expect(thisStart.getTime()).toBeGreaterThan(prevEnd.getTime());
    }
  });

  it('recurrence_end earlier than the default cutoff stops generation there', async () => {
    freezeTime('2026-01-01T00:00:00Z');
    const { container } = await seedRecurringContainer({
      recurrence_start: '2026-01-01', recurrence_cadence: 'monthly', recurrence_end: '2026-02-15',
    });

    await generateCycles({ container_id: container.id, generate_months_ahead: 6 });

    const { data: cycles } = await supabaseAdmin.from('container_cycles').select('*').eq('container_id', container.id);
    for (const c of cycles) {
      expect(new Date(c.cycle_start).getTime()).toBeLessThanOrEqual(new Date('2026-02-15').getTime());
    }
  });

  it('pause_pool override marks that cycle "skipped" with zero contributor_targets rows', async () => {
    freezeTime('2026-01-01T00:00:00Z');
    const { container, member } = await seedRecurringContainer({ recurrence_start: '2026-01-01', recurrence_cadence: 'monthly' });
    await supabaseAdmin.from('container_participants').insert({ container_id: container.id, workspace_member_id: member.id, money_enabled: true });
    await supabaseAdmin.from('pool_cycle_overrides').insert({
      container_id: container.id, cycle_start: '2026-01-01', override_type: 'pause_pool', created_by: member.id,
    });

    await generateCycles({ container_id: container.id, generate_months_ahead: 1 });

    const { data: cycle } = await supabaseAdmin.from('container_cycles').select('*').eq('container_id', container.id).eq('cycle_start', '2026-01-01').single();
    expect(cycle.status).toBe('skipped');

    const { count } = await supabaseAdmin.from('contributor_targets').select('*', { count: 'exact', head: true }).eq('cycle_id', cycle.id);
    expect(count).toBe(0);
  });

  it('skip_member override excludes that participant\'s target for that cycle; others unaffected', async () => {
    freezeTime('2026-01-01T00:00:00Z');
    const { container, member: skippedMember } = await seedRecurringContainer({ recurrence_start: '2026-01-01', recurrence_cadence: 'monthly' });
    const { member: normalMember } = await seedAdditionalMember(supabaseAdmin, container.workspace_id, {});

    await supabaseAdmin.from('container_participants').insert([
      { container_id: container.id, workspace_member_id: skippedMember.id, money_enabled: true },
      { container_id: container.id, workspace_member_id: normalMember.id, money_enabled: true },
    ]);
    // Both need a base (event-level) current target for the cycle
    // generation logic's fallback lookup to have something to copy.
    const { data: participantRows } = await supabaseAdmin.from('container_participants').select('id, workspace_member_id').eq('container_id', container.id);
    for (const p of participantRows) {
      await supabaseAdmin.from('contributor_targets').insert({
        container_participant_id: p.id, container_id: container.id, workspace_member_id: p.workspace_member_id,
        cycle_id: null, target_amount: 50, target_currency: 'USD', is_current: true, set_by: skippedMember.id,
      });
    }

    await supabaseAdmin.from('pool_cycle_overrides').insert({
      container_id: container.id, cycle_start: '2026-01-01', override_type: 'skip_member', member_id: skippedMember.id, created_by: skippedMember.id,
    });

    await generateCycles({ container_id: container.id, generate_months_ahead: 1 });

    const { data: cycle } = await supabaseAdmin.from('container_cycles').select('id').eq('container_id', container.id).eq('cycle_start', '2026-01-01').single();
    const { data: targets } = await supabaseAdmin.from('contributor_targets').select('*').eq('cycle_id', cycle.id);

    expect(targets.some((t) => t.workspace_member_id === skippedMember.id)).toBe(false);
    expect(targets.some((t) => t.workspace_member_id === normalMember.id)).toBe(true);
  });

  it('idempotent re-run produces no duplicate container_cycles rows', async () => {
    freezeTime('2026-01-01T00:00:00Z');
    const { container } = await seedRecurringContainer({ recurrence_start: '2026-01-01', recurrence_cadence: 'monthly' });

    await generateCycles({ container_id: container.id, generate_months_ahead: 2 });
    const { count: firstRunCount } = await supabaseAdmin.from('container_cycles').select('*', { count: 'exact', head: true }).eq('container_id', container.id);

    await generateCycles({ container_id: container.id, generate_months_ahead: 2 });
    const { count: secondRunCount } = await supabaseAdmin.from('container_cycles').select('*', { count: 'exact', head: true }).eq('container_id', container.id);

    expect(secondRunCount).toBe(firstRunCount);
  });

  // ── Concurrency race — Doc 1 Bug Review Finding 9 ──────────────
  describe('concurrency race (Doc 1 Finding 9) — real Queue + real Worker, concurrency: 5', () => {
    it('enqueuing two generate-cycles jobs for the SAME container back-to-back produces no duplicate/skipped cycle_number values', async () => {
      freezeTime('2026-01-01T00:00:00Z');
      const { container } = await seedRecurringContainer({ recurrence_start: '2026-01-01', recurrence_cadence: 'monthly' });

      const worker = createCycleGenerationWorker();
      const queue = getQueue('cycle-generation-queue');

      try {
        const completions = [];
        worker.on('completed', (job) => completions.push(job.id));

        const job1 = await queue.add('generate-cycles', { container_id: container.id, generate_months_ahead: 3 });
        const job2 = await queue.add('generate-cycles', { container_id: container.id, generate_months_ahead: 3 });

        // Wait for both jobs to complete (poll, since BullMQ processing
        // is asynchronous relative to this test's own event loop).
        const start = Date.now();
        while (completions.length < 2 && Date.now() - start < 15000) {
          await new Promise((r) => setTimeout(r, 100));
        }
        expect(completions).toEqual(expect.arrayContaining([job1.id, job2.id]));

        const { data: cycles } = await supabaseAdmin
          .from('container_cycles').select('cycle_number').eq('container_id', container.id).order('cycle_number');

        const cycleNumbers = cycles.map((c) => c.cycle_number);
        const uniqueNumbers = new Set(cycleNumbers);

        // THIS IS THE FINDING 9 ASSERTION: if cycle_number has
        // duplicates or gaps introduced by the race (two concurrent
        // reads of `lastCycle` before either writes), this test FAILS,
        // confirming Finding 9 as a live bug — per Doc 4 Section 5 P1
        // #11, escalate to P0 if this fails. Do not loosen this
        // assertion to force a pass.
        expect(uniqueNumbers.size).toBe(cycleNumbers.length); // no duplicates
        const sorted = [...uniqueNumbers].sort((a, b) => a - b);
        for (let i = 1; i < sorted.length; i++) {
          expect(sorted[i]).toBe(sorted[i - 1] + 1); // no gaps
        }
      } finally {
        await worker.close();
      }
    }, 20000);
  });
});
