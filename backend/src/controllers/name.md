feat(infra): add Redis primitives and Sentry error tracking

- Extend services/redis.js with distributed locks (acquireLock/
  releaseLock/withLock), hash/set/sorted-set operations, and
  getRawClient() for third-party Redis integrations.
- Add config/sentry.js (conditional init, no-ops without SENTRY_DSN)
  and utils/reportDegradation.js (throttled degraded-mode alerting,
  deliberately in-memory/per-process — see file header).
- Wire Sentry into jobHelpers.logJob and every BullMQ worker's 'failed'
  handler (scheduledWorker/practiceWorker/backgroundWorker), closing
  the original gap where a broken job_logs table had zero external
  visibility.

Refs: L4

refactor(ai): distributed provider state, structured retry classification

- Extract key-cooldown logic into services/providerCooldown.js, shared
  by multiProvider.js and exa.js, backed by Redis with an in-memory
  fallback (MULTIPROVIDER_REDIS_STATE_ENABLED kill switch).
- Add Redis-backed, lock-guarded model discovery cache in
  multiProvider.js so instances don't independently hit provider
  /models endpoints or silently diverge on model choice.
- Add utils/providerErrors.js (ProviderCallError + classifyProviderError)
  replacing string-substring error matching with structured,
  status-code-driven classification (KEY_FAULT / PROVIDER_TRANSIENT /
  BAD_MODEL / NON_RETRYABLE) — fixes 400s aborting the fallback chain
  while avoiding indiscriminate retry of genuine application bugs.
- BAD_MODEL classification now evicts the offending model from the
  Redis discovery cache.
- Sentry capture added at ALL_PROVIDERS_FAILED and NON_RETRYABLE choke
  points in multiProvider.js (most groq-*.js callers swallow errors
  locally, so automatic Express-level capture alone would miss these).
- Refactor exa.js onto the same shared providerCooldown module for
  consistent AI-infrastructure architecture.

Refs: MultiProvider Redis refactor, H8