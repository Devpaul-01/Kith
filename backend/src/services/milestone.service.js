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
const { AppError, NotFoundError } = require('../utils/errors');
const { generateUploadUrl, verifyUploadedFile, assertUploadPath } = require('./storage.service');

async function getTimelinePage({ workspaceId, limit, cursor }) {
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit) || 20));
  const beforeContainer = cursor?.before_container;
  const beforeMilestone = cursor?.before_milestone;
  let cQuery = supabaseAdmin.from('containers')
    .select('id, name, completed_at, outcome_details')
    .eq('workspace_id', workspaceId).eq('status', 'completed').is('deleted_at', null)
    .not('completed_at', 'is', null)
    .order('completed_at', { ascending: false }).order('id', { ascending: true }).limit(safeLimit + 1);
  let mQuery = supabaseAdmin.from('milestones')
    .select('id, title, description, milestone_date')
    .eq('workspace_id', workspaceId).is('deleted_at', null)
    .order('milestone_date', { ascending: false }).order('id', { ascending: true }).limit(safeLimit + 1);

  // Agent validators restrict cursor values to timestamps/dates and UUIDs;
  // they cannot carry PostgREST filter syntax. IDs preserve same-date rows.
  if (beforeContainer) cQuery = cQuery.or(`completed_at.lt.${beforeContainer.date},and(completed_at.eq.${beforeContainer.date},id.gt.${beforeContainer.id})`);
  if (beforeMilestone) mQuery = mQuery.or(`milestone_date.lt.${beforeMilestone.date},and(milestone_date.eq.${beforeMilestone.date},id.gt.${beforeMilestone.id})`);
  const [containerResponse, milestoneResponse] = await Promise.all([cQuery, mQuery]);
  if ([containerResponse, milestoneResponse].some((response) => response.error || !Array.isArray(response.data))) {
    throw new AppError('Timeline is unavailable. Please try again.', 503, 'TIMELINE_UNAVAILABLE');
  }
  const candidates = [
    ...containerResponse.data.map((row) => ({ type: 'container_completed', date: row.completed_at,
      title: row.name, description: row.outcome_details, reference_id: row.id, reference_type: 'container' })),
    ...milestoneResponse.data.map((row) => ({ type: 'milestone', date: row.milestone_date,
      title: row.title, description: row.description, reference_id: row.id, reference_type: 'milestone' })),
  ];
  if (candidates.some((row) => !Number.isFinite(Date.parse(row.date)))) {
    throw new AppError('Timeline dates are unavailable. Please try again.', 503, 'TIMELINE_UNAVAILABLE');
  }
  // Keep database order within a source, including sub-millisecond timestamps.
  // Container completions precede milestones when their instants are equal.
  const items = candidates.sort((a, b) => Date.parse(b.date) - Date.parse(a.date)
    || (a.reference_type === b.reference_type ? 0 : a.reference_type === 'container' ? -1 : 1)).slice(0, safeLimit);
  const hasMore = candidates.length > items.length;
  const lastContainer = items.filter((row) => row.reference_type === 'container').at(-1);
  const lastMilestone = items.filter((row) => row.reference_type === 'milestone').at(-1);
  return { items, has_more: hasMore, next_cursor: hasMore ? {
    before_container: lastContainer ? { date: lastContainer.date, id: lastContainer.reference_id } : beforeContainer || null,
    before_milestone: lastMilestone ? { date: lastMilestone.date, id: lastMilestone.reference_id } : beforeMilestone || null,
  } : null };
}

async function getTimeline({ workspaceId, limit, before, beforeContainer, beforeMilestone, cursor, metadataOnly = false }) {
  if (metadataOnly) return getTimelinePage({ workspaceId, limit, cursor });
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

  // Cursors advance only past items actually RETURNED on this page.
  // Basing them on the last row *fetched* from each source skips the
  // fetched-but-trimmed rows, and a source with nothing on this page must
  // keep the incoming cursor (resetting it to null restarts that source
  // from the top and duplicates items on the next page).
  const returnedContainers = items.filter((i) => i.reference_type === 'container');
  const returnedMilestones = items.filter((i) => i.reference_type === 'milestone');
  const lastContainer = returnedContainers[returnedContainers.length - 1];
  const lastMilestone = returnedMilestones[returnedMilestones.length - 1];

  const fetchedCount = (containers?.length || 0) + (milestones?.length || 0);

  return {
    items,
    next_cursor: {
      before_container: lastContainer?.date || resolvedBeforeContainer || null,
      before_milestone: lastMilestone?.date || resolvedBeforeMilestone || null,
    },
    has_more: fetchedCount > items.length
      || (containers?.length === safeLimit) || (milestones?.length === safeLimit),
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

async function getMilestone({ workspaceId, milestoneId, metadataOnly = false }) {
  const { data: milestone, error } = await supabaseAdmin
    .from('milestones')
    .select(metadataOnly ? 'id, title, description, milestone_date, milestone_type, created_at, updated_at' : '*')
    .eq('id', milestoneId)
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) throw new AppError('Milestones are unavailable. Please try again.', 503, 'MILESTONES_UNAVAILABLE');
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
  assertUploadPath(filePayload.file_path, `workspaces/${workspaceId}/milestones/${milestoneId}/`);
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
