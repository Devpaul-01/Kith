// src/services/storage.service.js
const { supabase } = require('../config/supabase');
const { BusinessRuleError } = require('../utils/errors');
const logger = require('../utils/logger');

const BUCKET = process.env.STORAGE_BUCKET_NAME || 'kith-files';

// Issue M13 fix: validateUpload() below only ever checked CLIENT-DECLARED
// content_type/file_size before issuing a signed direct-to-storage upload
// URL — nothing re-validated the actual uploaded bytes afterward. A client
// could declare "image/jpeg" and upload anything (e.g. an HTML file with
// an embedded script, served back with an image content-type). Every
// upload flow in this app (ledger proofs, task proofs, milestone photos)
// already has a "confirm" step that runs strictly AFTER the file lands in
// storage — verifyUploadedFile() hooks into exactly that step, so no
// Supabase Storage webhook or extra infrastructure is required.
//
// Set FILE_VERIFICATION_ENABLED=false to disable if this proves too costly
// at scale (it downloads the full file to check its signature bytes) —
// defaults to enabled since this is a security control, not a convenience
// feature like the idempotency-key flag elsewhere in the codebase.
const FILE_VERIFICATION_ENABLED = process.env.FILE_VERIFICATION_ENABLED !== 'false';

// First-N-bytes signatures for the file types this app actually accepts
// (see ALLOWED_TYPES below). Types not listed here are skipped rather than
// rejected, since we don't have a signature to check them against.
const MAGIC_BYTES = {
  'image/jpeg': [[0xFF, 0xD8, 0xFF]],
  'image/png':  [[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]],
  'image/gif':  [[0x47, 0x49, 0x46, 0x38]], // "GIF8"
  'application/pdf': [[0x25, 0x50, 0x44, 0x46]], // "%PDF"
  // WEBP: RIFF....WEBP — the "WEBP" marker sits at byte offset 8, not 0,
  // so this one gets a dedicated check below rather than a simple prefix.
};

function matchesMagicBytes(buffer, contentType) {
  if (contentType === 'image/webp') {
    return (
      buffer.length >= 12 &&
      buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
      buffer.slice(8, 12).toString('ascii') === 'WEBP'
    );
  }
  const signatures = MAGIC_BYTES[contentType];
  if (!signatures) return true; // no known signature for this type — don't block
  return signatures.some((sig) => sig.every((byte, i) => buffer[i] === byte));
}

/**
 * Downloads the uploaded file and checks its actual byte signature against
 * the content_type that was declared (and validated) at upload-URL
 * generation time. Throws BusinessRuleError on mismatch. Call this from
 * the "confirm" step of any upload flow, after the client reports the
 * upload as complete but before treating the file as trusted (e.g. before
 * attaching it to a ledger entry, task, or milestone).
 */
async function verifyUploadedFile(filePath, declaredContentType) {
  if (!FILE_VERIFICATION_ENABLED) return true;

  try {
    const { data, error } = await supabase.storage.from(BUCKET).download(filePath);
    if (error) {
      // If we can't even download the file we just uploaded, something is
      // wrong enough to fail closed rather than silently trust it.
      throw new Error(error.message);
    }

    const buffer = Buffer.from(await data.arrayBuffer());

    if (!matchesMagicBytes(buffer, declaredContentType)) {
      throw new BusinessRuleError(
        `Uploaded file does not match its declared type (${declaredContentType}). The file may be corrupted, mislabeled, or not actually an image/PDF.`
      );
    }

    return true;
  } catch (err) {
    if (err instanceof BusinessRuleError) throw err;
    logger.error('File verification failed unexpectedly', { filePath, declaredContentType, error: err.message });
    throw new BusinessRuleError('Could not verify the uploaded file. Please try uploading again.');
  }
}

const MAX_SIZES = {
  proof:          10 * 1024 * 1024,  // 10 MB
  task_proof:     10 * 1024 * 1024,  // 10 MB
  cover_photo:    10 * 1024 * 1024,  // 10 MB
  outcome_file:   50 * 1024 * 1024,  // 50 MB
  milestone_photo:10 * 1024 * 1024,  // 10 MB
  avatar:          5 * 1024 * 1024,  //  5 MB
  workspace_avatar: 5 * 1024 * 1024, //  5 MB  // ← ADD THIS
};

const ALLOWED_TYPES = {
  proof:          ['image/jpeg','image/png','image/webp','image/gif','application/pdf'],
  task_proof:     ['image/jpeg','image/png','image/webp','image/gif','application/pdf'],
  cover_photo:    ['image/jpeg','image/png','image/webp','image/gif'],
  outcome_file:   ['image/jpeg','image/png','image/webp','image/gif','application/pdf'],
  milestone_photo:['image/jpeg','image/png','image/webp','image/gif'],
  avatar:         ['image/jpeg','image/png','image/webp'],
  workspace_avatar: ['image/jpeg','image/png','image/webp'],  // ← ADD THIS
};

function validateUpload(fileType, contentType, fileSize) {
  const maxSize = MAX_SIZES[fileType];
  const allowedTypes = ALLOWED_TYPES[fileType];

  if (!maxSize) throw new BusinessRuleError(`Unknown file type: ${fileType}`);

  if (fileSize > maxSize) {
    throw new BusinessRuleError(
      `File too large. Maximum size for ${fileType}: ${maxSize / 1024 / 1024}MB`
    );
  }

  const isAllowedType =
    allowedTypes.includes(contentType) ||
    (contentType.startsWith('image/') && allowedTypes.some((t) => t.startsWith('image/')));

  if (!isAllowedType) {
    throw new BusinessRuleError(`File type "${contentType}" is not allowed for ${fileType}`);
  }
}


/**
 * Generate a signed upload URL for Supabase Storage.
 *
 * Path resolution:
 *   workspaceId provided → workspaces/{workspaceId}/{folder}/{filename}
 *   userId provided only → users/{userId}/{folder}/{filename}
 *
 * Always pass either workspaceId or userId. Both is fine (workspaceId takes precedence).
 */
async function generateUploadUrl({
  workspaceId,
  userId,
  folder,
  filename,
  contentType,
  fileSize,
  fileType,
}) {
  validateUpload(fileType, contentType, fileSize);

  const ext = filename.split('.').pop()?.toLowerCase() || 'bin';
  const safeFilename = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

  // Determine base path
  let basePath;
  if (workspaceId) {
    basePath = `workspaces/${workspaceId}`;
  } else if (userId) {
    basePath = `users/${userId}`;
  } else {
    throw new BusinessRuleError('Either workspaceId or userId is required for file upload');
  }

  const filePath = `${basePath}/${folder}/${safeFilename}`;

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUploadUrl(filePath, { upsert: false });

  if (error) throw new Error(`Storage error: ${error.message}`);

  return {
    upload_url: data.signedUrl,
    file_path:  filePath,
    expires_in: 300,
  };
}

/**
 * Generate a signed download URL (15-minute default expiry).
 */
async function generateDownloadUrl(filePath, expiresIn = 900) {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(filePath, expiresIn);

  if (error) throw new Error(`Storage error: ${error.message}`);
  return { download_url: data.signedUrl, expires_in: expiresIn };
}

/**
 * Permanently delete a file from storage.
 */
async function deleteFile(filePath) {
  const { error } = await supabase.storage.from(BUCKET).remove([filePath]);
  if (error) throw new Error(`Storage delete error: ${error.message}`);
}

module.exports = { generateUploadUrl, generateDownloadUrl, deleteFile, validateUpload, verifyUploadedFile };
