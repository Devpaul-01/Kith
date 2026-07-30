// tests/helpers/timeHelper.js
//
// Doc 4 Section 1.5: every test touching date-based business logic
// (cycle generation, reminder scans, overdue checks, JWT/cookie expiry)
// must use fake timers with a fixed "now" rather than relying on
// Date.now() drift being "close enough" — several boundary tests (e.g.
// "due in exactly 7 days" vs "8 days") require an exact, reproducible
// now.
//
// USAGE:
//   const { freezeTime, unfreezeTime } = require('../../helpers/timeHelper');
//
//   describe('reminder scan', () => {
//     beforeEach(() => freezeTime('2026-07-21T00:00:00Z'));
//     afterEach(unfreezeTime);
//
//     it('sends a reminder for a target due in exactly 7 days', async () => { ... });
//   });

function freezeTime(isoString = '2026-07-21T00:00:00Z') {
  jest.useFakeTimers({ doNotFake: ['nextTick'] });
  jest.setSystemTime(new Date(isoString));
}

function unfreezeTime() {
  jest.useRealTimers();
}

/** Advance the frozen clock by N days (useful for cycle-lifecycle/multi-step tests). */
function advanceDays(days) {
  const current = new Date();
  current.setDate(current.getDate() + days);
  jest.setSystemTime(current);
}

module.exports = { freezeTime, unfreezeTime, advanceDays };
