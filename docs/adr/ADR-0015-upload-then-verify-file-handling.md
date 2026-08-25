# ADR-0015: Upload-Then-Verify File Handling with Magic-Byte Checks

**Status:** Accepted

## Context

The application accepts several categories of user-uploaded files:
ledger-entry proofs, task proofs, milestone photos, cover photos, outcome
files, and avatars — all via a signed-URL flow where the client uploads
directly to Supabase Storage (see ADR-0004), then calls a "confirm"
endpoint to attach the resulting file reference to the relevant record.

Client-declared `content_type`/`file_size` checks at signed-URL-issuance
time establish reasonable request-shape validation, but nothing about that
step re-validates the actual uploaded bytes afterward. A client could
declare `image/jpeg` and upload anything — for example, an HTML file with
an embedded script, later served back with an image content-type. This is
a real risk specifically because the files are later served back — a
proof-of-payment image or milestone photo is rendered directly in a client
UI, and a mismatched, attacker-controlled content-type served back to
other users is a stored-content injection vector.

## Problem Statement

Client-declared content-type and file-size checks happen *before* the
actual bytes exist in storage (the signed URL is issued speculatively).
How do you verify what was *actually* uploaded, given the upload itself
happens directly between the client and Supabase Storage, bypassing the
API server entirely?

## Decision

Two-phase validation:

1. **At signed-URL issuance** (`generateUploadUrl` →
   `validateUpload(fileType, contentType, fileSize)`): check the
   client-declared `content_type` against a per-file-type allowlist
   (`ALLOWED_TYPES`) and `file_size` against a per-file-type cap
   (`MAX_SIZES`, e.g. 10MB for proofs, 5MB for avatars). This is a
   pre-check against obviously-wrong requests, not a security boundary by
   itself.
2. **At confirm time** (`verifyUploadedFile(filePath,
   declaredContentType)`), called from every "confirm" service function
   that trusts an uploaded file (`ledger.service.js#confirmProof`,
   `task.service.js#confirmTaskProof`,
   `milestone.service.js#confirmMilestonePhoto`): download the file from
   Supabase Storage and check its actual first bytes against a
   `MAGIC_BYTES` signature table for the declared content type (JPEG's
   `0xFFD8FF`, PNG's 8-byte signature, GIF's `"GIF8"`, PDF's `"%PDF"`, and
   a dedicated offset check for WEBP's `RIFF....WEBP` structure, since its
   marker sits at byte offset 8 rather than the start of the file).
   Mismatches throw `BusinessRuleError`, blocking the confirm step
   entirely — the file reference is never attached to the ledger
   entry/task/milestone if its bytes don't match its declared type.

This hooks into the existing confirm step rather than requiring new
infrastructure: every upload flow in this app already has a "confirm" step
that runs strictly after the file lands in storage, so no Supabase Storage
webhook or extra infrastructure is required.

The check is gated by `FILE_VERIFICATION_ENABLED` (default: **on**),
treated as a security control rather than a convenience feature — the
flag exists specifically to allow disabling it if the cost of downloading
the full file to check its signature bytes ever proves too high at scale,
not as a default-off convenience toggle.

## Alternatives Considered

- **Client-declared content-type checks only.** Rejected — a client can
  declare anything regardless of what it actually uploads, so this alone
  provides no real guarantee about file contents.
- **A Supabase Storage webhook triggering verification asynchronously
  after upload.** Would decouple verification from the confirm step, but
  requires additional infrastructure (a webhook endpoint, a way to
  correlate the webhook event back to the pending ledger entry/task/
  milestone) that the existing confirm-step flow doesn't need.
- **Full content scanning / antivirus integration.** Not implemented —
  magic-byte signature checking verifies the file's *type* matches what
  was declared, not that the file's *content* is safe from a malware
  perspective. This is a narrower, more targeted guarantee than a full
  antivirus scan would provide, and is treated as a distinct, optional
  layer that could be added on top if ever needed.

## Rationale

The specific risk this closes — an HTML file with an embedded script,
served back with an image content-type — is a stored XSS-adjacent risk
that magic-byte checking directly addresses for the exact file types this
app accepts (images and PDFs), without needing general malware detection.
The fix is scoped precisely to the actual risk identified, rather than
over-engineered into a broader content-security system.

## Trade-offs

- Verification requires downloading the full file from storage to inspect
  its bytes — larger files (up to the 50MB cap for `outcome_file`) cost
  proportionally more to verify, since the current implementation
  downloads the whole file rather than only its first N bytes.
- Content types with no entry in `MAGIC_BYTES` are not blocked
  (`matchesMagicBytes` returns `true` when there's no known signature for
  a type) — verification is a positive allowlist of checked types, not a
  universal guarantee for every content type `ALLOWED_TYPES` permits.

## Consequences

- Every "confirm" flow across ledger proofs, task proofs, and milestone
  photos shares the exact same verification call
  (`verifyUploadedFile`), so a fix or enhancement to the signature table
  benefits every upload flow simultaneously rather than needing to be
  applied N times.
- `avatar` and `workspace_avatar` uploads are validated for allowed
  types/sizes at `generateUploadUrl` time. `updateProfile` and
  `updateWorkspace` accept an `avatar_url` string directly rather than
  routing through a confirm-and-verify step the way proofs and photos do,
  which is an intentional distinction: avatars are a lower-sensitivity
  asset class than financial proofs or shared family photos.

## Related Files

- `src/services/storage.service.js` (`validateUpload`, `verifyUploadedFile`,
  `MAGIC_BYTES`, `matchesMagicBytes`)
- `src/services/ledger.service.js` (`confirmProof`)
- `src/services/task.service.js` (`confirmTaskProof`)
- `src/services/milestone.service.js` (`confirmMilestonePhoto`)
