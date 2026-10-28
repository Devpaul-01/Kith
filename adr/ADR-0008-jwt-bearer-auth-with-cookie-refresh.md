# ADR-0008: JWT Bearer Access Tokens with HttpOnly Cookie Refresh

**Status:** Accepted

## Context

The API serves both a web frontend (subject to CORS/cookie behavior) and
non-browser clients — mobile push tokens are tracked per platform in
`auth.service.js#registerPushToken`, implying mobile clients are a real,
supported case. Session tokens need to be short-lived for security but the
user shouldn't have to re-authenticate constantly, which is the classic
access/refresh token split.

## Problem Statement

How should access and refresh tokens be transported such that (a) the
access token is available to non-browser clients (mobile apps can't easily
use cookies the way browsers do), (b) the refresh token is protected from
XSS-based theft, and (c) CORS/CSRF behavior is safe by default?

## Decision

- **Access tokens** (`access_token`, short-lived, Supabase-issued JWT) are
  returned in the JSON response body from login/refresh/signup/OAuth
  endpoints and sent by the client as a standard `Authorization: Bearer
  <token>` header on every subsequent request. `requireAuth`
  (`middleware/auth.js`) verifies this via
  `supabaseAdmin.auth.getUser(token)`.
- **Refresh tokens** are set as an `httpOnly`, `secure` (in production),
  `sameSite: 'strict'` cookie named `refresh_token`, scoped to the
  `/v1/auth/refresh` path only (`REFRESH_COOKIE_OPTS` in
  `auth.controller.js`), with a 30-day `maxAge`. Every response that
  issues a new session (`login`, `refreshToken`, `googleCallback`)
  destructures `refresh_token` out of the service response and calls
  `setRefreshCookie()` before stripping it from the JSON body — the
  refresh token is never returned in a JSON response body, only ever set
  as a cookie.
- `logout`/`logoutAllDevices` clear the cookie (`res.clearCookie
  ('refresh_token', { path: '/v1/auth/refresh' })`) and call Supabase's
  `auth.admin.signOut` (single-session or `'global'` scope respectively).
- CORS is configured with `credentials: true` and an explicit
  `origin: process.env.FRONTEND_URL`, which is required for the browser to
  actually send the `httpOnly` cookie cross-origin.

## Alternatives Considered

- **Refresh token also in the JSON body / localStorage.** Rejected — an
  `httpOnly` cookie is inaccessible to JavaScript, which is the specific
  property that protects the long-lived refresh token from XSS. Access
  tokens are short-lived enough that the same protection matters less for
  them, and they need to be readable by non-browser clients anyway (an
  `httpOnly` cookie wouldn't work for a mobile app the same way).
- **Both tokens as cookies.** Would work for the web client but would
  complicate non-browser clients (mobile), which is why the access token
  stays header-based — the codebase tracks push tokens per-platform
  (`web`, `ios`, `android`), so non-browser clients are a real, supported
  case.
- **Wildcard (`*`) CORS origin with a fallback.** Explicitly avoided:
  browsers reject wildcard origin plus credentialed requests outright, so
  if `FRONTEND_URL` were ever unset, cookie-based auth would silently stop
  working rather than silently becoming insecure. `server.js`'s
  `validateEnvironment()` refuses to boot without `FRONTEND_URL` set,
  making a fallback both unnecessary and a source of confusion about the
  real failure mode.

## Rationale

`resetPassword` in `auth.service.js` demonstrates a security-conscious
extension of this pattern: rather than trusting *any* currently-valid
access token to authorize a password reset, `isRecoverySession()` decodes
the JWT and checks its `amr` (Authentication Methods Reference) claim for
a `recovery` entry — a claim Supabase specifically includes when the
session was established via the password-recovery OTP flow. This closes a
gap where a stolen-but-still-valid regular access token could be used to
silently reset a password via the recovery endpoint.

## Trade-offs

- The `refresh_token` cookie is scoped to `path: '/v1/auth/refresh'`,
  meaning it is *not* sent on every request — only on calls to that
  specific refresh endpoint. This is a deliberate minimization (the cookie
  is exposed to the smallest possible attack surface) but means the
  refresh flow must always hit that exact path.
- `sameSite: 'strict'` means the refresh cookie will not be sent on
  cross-site navigations at all (not even top-level GET navigations from
  an external link), which is the most restrictive `sameSite` setting —
  correct for an API-only cookie that should never be triggered by
  third-party sites, but worth knowing if a future flow (e.g. an OAuth
  redirect landing page) unexpectedly needs the cookie present on first
  load.

## Consequences

- `requireAuth` never touches cookies — access-token verification is
  entirely header-based, keeping that middleware provider-agnostic aside
  from the `supabaseAdmin.auth.getUser` call itself.
- Any future non-web client (mobile, CLI) can reuse the exact same access-
  token flow without needing cookie support, as long as it has its own
  secure storage for the refresh token (mobile apps typically use
  OS-level secure storage rather than cookies) — a dedicated mobile
  refresh mechanism, if different from the cookie-based web flow, would
  be a natural extension point rather than a redesign.

## Related Files

- `src/controllers/auth.controller.js` (`REFRESH_COOKIE_OPTS`,
  `setRefreshCookie`)
- `src/services/auth.service.js` (`isRecoverySession`, `resetPassword`)
- `src/middleware/auth.js` (`requireAuth`)
- `src/app.js` (CORS configuration)
