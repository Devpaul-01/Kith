# Architecture Decision Records — Kith Backend

This directory contains the Architecture Decision Records (ADRs) for the Kith
backend (`kith-backend`), a family coordination API built on Express,
Supabase (Postgres + Auth + Storage), Redis, and BullMQ.

## What is an ADR?

An Architecture Decision Record captures a single significant architectural
or engineering decision: the problem it responds to, the options that were
weighed, the choice that was made, and the trade-offs that choice implies.
ADRs are not design specs and they are not API documentation — they are a
paper trail for *why* the system looks the way it does, written while the
reasoning and alternatives were still fresh.

## Why this project uses them

Kith's backend has been through several rounds of internal design and
security review over the course of development, and a number of decisions
here were the direct result of that process — a problem was found, a fix
was chosen over the available alternatives, and the reasoning was worth
preserving beyond the code itself. This ADR set exists so that reasoning
survives independently of the specific point in the project's history that
originally produced it.

## How to read them

Each ADR follows the same structure:

- **Status** — almost all records here are `Accepted`, since they describe
  decisions already implemented and running in the codebase. A `Superseded`
  status is used where a later decision explicitly replaced an earlier one
  (e.g. the rate-limiter split superseded the original single-limiter
  design).
- **Context** — the situation that made a decision necessary.
- **Problem Statement** — the specific question being answered.
- **Decision** — what was actually built.
- **Alternatives Considered** — other approaches, and why they were set
  aside.
- **Rationale** — why this option won.
- **Trade-offs** — what was given up, explicitly, in exchange.
- **Consequences** — the downstream effects, positive and negative, on the
  rest of the system.
- **Related Files** — the actual modules this decision lives in, so the
  document map stays checkable against the source.

## Naming convention

`ADR-XXXX-kebab-case-title.md`, numbered sequentially in the rough order the
underlying decisions were made (project/runtime shape first, then
persistence and caching, then request-handling concerns, then background
processing, then cross-cutting concerns like validation and error handling).
The number is a stable identifier — once assigned it is never reused or
reordered, even if a later ADR supersedes an earlier one.

## Status lifecycle

- **Proposed** — under discussion, not yet implemented.
- **Accepted** — implemented and current.
- **Superseded by ADR-XXXX** — replaced by a later decision; the record is
  kept for history rather than deleted.
- **Deprecated** — no longer applicable (e.g. the underlying feature was
  removed) but kept for context.

## Adding a new ADR

1. Copy the structure of an existing ADR.
2. Use the next sequential number.
3. Fill in every section — if a section genuinely doesn't apply (e.g. no
   real alternatives were considered), say so explicitly rather than
   omitting the heading.
4. Reference the actual files the decision touches.
5. Add the new file to the index below.

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](./ADR-0001-single-process-runtime-with-independent-entrypoints.md) | Single-Process Runtime with Independent Entry Points | Accepted |
| [0002](./ADR-0002-layered-controller-service-architecture.md) | Layered Controller/Service Architecture | Accepted |
| [0003](./ADR-0003-resource-based-router-splitting.md) | Resource-Based Router Splitting | Accepted |
| [0004](./ADR-0004-supabase-as-data-auth-storage-provider.md) | Supabase as Combined Data, Auth, and Storage Provider | Accepted |
| [0005](./ADR-0005-dual-supabase-client-service-role-vs-anon.md) | Dual Supabase Client: Service-Role vs. Anon Key | Accepted |
| [0006](./ADR-0006-redis-backed-rate-limiting.md) | Redis-Backed, Dual-Tier Rate Limiting | Accepted |
| [0007](./ADR-0007-redis-membership-cache.md) | Short-Lived Redis Cache for Workspace Membership | Accepted |
| [0008](./ADR-0008-jwt-bearer-auth-with-cookie-refresh.md) | JWT Bearer Access Tokens with HttpOnly Cookie Refresh | Accepted |
| [0009](./ADR-0009-404-not-403-for-workspace-access.md) | 404-Not-403 for Unauthorized Workspace Access | Accepted |
| [0010](./ADR-0010-postgres-rpcs-for-multi-step-writes.md) | Postgres RPCs for Atomic Multi-Step Writes | Accepted |
| [0011](./ADR-0011-soft-deletes-and-audit-log.md) | Soft Deletes with a Centralized Audit Log | Accepted |
| [0012](./ADR-0012-idempotency-keys-on-ledger-writes.md) | Idempotency Keys on Financial Ledger Writes | Accepted |
| [0013](./ADR-0013-bullmq-queue-per-job-scheduling.md) | BullMQ with One Queue Per Job Type for Scheduling | Accepted |
| [0014](./ADR-0014-notification-outbox-pattern.md) | Template Registry, Dedup, and Outbox Pattern for Notifications | Accepted |
| [0015](./ADR-0015-upload-then-verify-file-handling.md) | Upload-Then-Verify File Handling with Magic-Byte Checks | Accepted |
| [0016](./ADR-0016-zod-schema-validation-with-shared-enums.md) | Zod Schema Validation with Shared Enum Sources of Truth | Accepted |
| [0017](./ADR-0017-typed-error-hierarchy-and-central-handler.md) | Typed Error Hierarchy with a Central Error Handler | Accepted |
| [0018](./ADR-0018-shared-pagination-and-sorting-utilities.md) | Shared Pagination and Sorting Utilities | Accepted |

## Related documentation

- [Architecture Overview](../ARCHITECTURE.md) — the system-level design these decisions collectively produced.
- [Background Jobs](../BACKGROUND_JOBS.md) — the queue/worker system referenced throughout ADR-0001 and ADR-0013–0014.
- [Security](../SECURITY.md) — the security posture several of these ADRs (0005, 0006, 0007, 0008, 0009) directly implement.
