// src/services/milestone.service.js
//
// Preserves the per-source-cursor pagination fix: a per-source cursor
// (not one shared `before` cursor) so an uneven split between the two
// merged sources (completed containers + milestones) can never skip an
// already-fetched-but-unused item on the next page.
//
// Back-compat: a bare `before` still seeds both cursors (correct for the
// first "load more" call); per-source cursors take precedence once the
// client has them from a previous response.

const { supabaseAdmin }      = require('../config/supabase');
const { NotFoundError }      = require('../utils/errors');
const { generateUploadUrl, verifyUploadedFile } = require('./storage.service');

async function getTimeline({ workspaceId, limit, before, beforeContainer, beforeMilestone }) {
  const safeLimit = Math.min(100, parseInt(limit) || 50);

  const resolvedBeforeContainer = beforeContainer || before;
  const resolvedBeforeMilestone = beforeMilestone || before;

  let cQuery = supabaseAdmin
    .from('containers')
    .select('id, name, completed_at, outcome_details, outcome_files')
    .eq('workspace_id', workspaceId)
    .eq('status', 'completed')
    .is('deleted_at', null)
    .order('completed_at', { ascending: false })
    .limit(safeLimit);

  if (resolvedBeforeContainer) cQuery = cQuery.lt('completed_at', resolvedBeforeContainer);

  let mQuery = supabaseAdmin
    .from('milestones')
    .select('id, title, description, milestone_date, photos')
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .order('milestone_date', { ascending: false })
    .limit(safeLimit);

  if (resolvedBeforeMilestone) mQuery = mQuery.lt('milestone_date', resolvedBeforeMilestone);

  const [{ data: containers }, { data: milestones }] = await Promise.all([cQuery, mQuery]);

  const containerItems = (containers || []).map((c) => ({ type: 'container_completed', date: c.completed_at,    title: c.name,  description: c.outcome_details, photos: c.outcome_files, reference_id: c.id, reference_type: 'container' }));
  const milestoneItems = (milestones  || []).map((m) => ({ type: 'milestone',          date: m.milestone_date, title: m.title, description: m.description,     photos: m.photos,        reference_id: m.id, reference_type: 'milestone' }));

  const items = [...containerItems, ...milestoneItems]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, safeLimit);

  const lastContainer = (containers  || [])[containers?.length  - 1];
  const lastMilestone = (milestones  || [])[milestones?.length  - 1];

  return {
    items,
    next_cursor: {
      before_container: lastContainer?.completed_at    || null,
      before_milestone: lastMilestone?.milestone_date  || null,
    },
    has_more: (containers?.length === safeLimit) || (milestones?.length === safeLimit),
  };
}

async function createMilestone({ workspaceId, title, milestone_date, description, milestone_type, actorMemberId }) {
  const { data: milestone, error } = await supabaseAdmin
    .from('milestones')
    .insert({ workspace_id: workspaceId, title, milestone_date, description: description || null, milestone_type, created_by: actorMemberId })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return milestone;
}

async function getMilestone({ workspaceId, milestoneId }) {
  const { data: milestone, error } = await supabaseAdmin
    .from('milestones')
    .select('*')
    .eq('id', milestoneId)
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!milestone) throw new NotFoundError('Milestone not found');

  return milestone;
}

const MILESTONE_UPDATE_ALLOWED_FIELDS = ['title', 'description', 'milestone_date', 'milestone_type'];

async function updateMilestone({ workspaceId, milestoneId, data }) {
  const updates = {};
  for (const f of MILESTONE_UPDATE_ALLOWED_FIELDS) { if (data[f] !== undefined) updates[f] = data[f]; }

  if (!Object.keys(updates).length) {
    const { data: m } = await supabaseAdmin.from('milestones').select('*').eq('id', milestoneId).single();
    return m;
  }

  updates.updated_at = new Date().toISOString();

  const { data: milestone, error } = await supabaseAdmin
    .from('milestones').update(updates).eq('id', milestoneId).eq('workspace_id', workspaceId).is('deleted_at', null).select().maybeSingle();

  if (error) throw new Error(error.message);
  if (!milestone) throw new NotFoundError('Milestone not found');

  return milestone;
}

async function deleteMilestone({ workspaceId, milestoneId }) {
  await supabaseAdmin.from('milestones').update({ deleted_at: new Date().toISOString() }).eq('id', milestoneId).eq('workspace_id', workspaceId);
}

async function getMilestonePhotoUploadUrl({ workspaceId, milestoneId, filename, contentType, fileSize }) {
  return generateUploadUrl({ workspaceId, folder: `milestones/${milestoneId}`, filename, contentType, fileSize, fileType: 'milestone_photo' });
}

async function confirmMilestonePhoto({ workspaceId, milestoneId, filePayload, actorMemberId }) {
  const { data: milestone } = await supabaseAdmin.from('milestones').select('*').eq('id', milestoneId).eq('workspace_id', workspaceId).is('deleted_at', null).maybeSingle();
  if (!milestone) throw new NotFoundError('Milestone not found');

  // Verify the uploaded file's actual bytes match its declared content
  // type before trusting it as a milestone photo.
  await verifyUploadedFile(filePayload.file_path, filePayload.mime_type);

  const fileObject    = { url: filePayload.file_path, name: filePayload.name, size: filePayload.size, mime_type: filePayload.mime_type, uploaded_by: actorMemberId, uploaded_at: new Date().toISOString() };
  const currentPhotos = Array.isArray(milestone.photos) ? milestone.photos : [];

  const { data: updated, error } = await supabaseAdmin
    .from('milestones')
    .update({ photos: [...currentPhotos, fileObject], updated_at: new Date().toISOString() })
    .eq('id', milestoneId)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return updated;
}

module.exports = {
  getTimeline,
  createMilestone,
  getMilestone,
  updateMilestone,
  deleteMilestone,
  getMilestonePhotoUploadUrl,
  confirmMilestonePhoto,
};
