// src/constants/ledger-status.js
//
// Single source of truth for which ledger_entries.status values count as
// "money actually received" vs. still-outstanding vs. terminal-but-unpaid.
//
// Bug this fixes: every money total in the app (ledger summary, dashboard,
// participant/container paid totals, invite preview, cycle-close
// carry-forward) filtered on status === 'confirmed' only. A dispute that
// gets raised and then resolved moves the entry to a THIRD terminal
// status, 'resolved' (see the enforce_ledger_entry_immutability trigger's
// confirmed -> disputed -> resolved transition in migrations/001_schema.sql)
// — that status was never included in any "confirmed" filter, so a
// legitimately settled contribution silently dropped out of every paid
// total, and cycle_lifecycle.service.js#carryForwardUnpaid would then
// treat it as still owed and add it as a NEW debt on the next cycle,
// double-charging the contributor.
//
// Import PAID_STATUSES wherever a query/filter means "this entry
// represents money the contributor actually has credit for" instead of
// repeating .eq('status', 'confirmed') or .in('status', [...]) ad hoc —
// that repetition is exactly how the original bug happened, and the next
// money-total call site should not have to rediscover this.

const PAID_STATUSES = Object.freeze(['confirmed', 'resolved']);

// Entries still awaiting admin action — not yet money the contributor can
// be credited for, but not rejected either.
const PENDING_STATUSES = Object.freeze(['pending', 'proof_uploaded']);

module.exports = { PAID_STATUSES, PENDING_STATUSES };
