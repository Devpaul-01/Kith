// src/services/storage.service.js
const { supabase } = require('../config/supabase');
const { BusinessRuleError } = require('../utils/errors');

const BUCKET = process.env.STORAGE_BUCKET_NAME || 'kith-files';

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

module.exports = { generateUploadUrl, generateDownloadUrl, deleteFile, validateUpload };
