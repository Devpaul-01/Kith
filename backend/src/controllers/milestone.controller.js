// src/controllers/milestone.controller.js
const { supabaseAdmin }      = require('../config/supabase');
const { success, noContent } = require('../utils/response');
const { NotFoundError }      = require('../utils/errors');
const { createMilestoneSchema, updateMilestoneSchema, uploadFileSchema, confirmProofSchema } = require('../validators/ledger.validator');
const { generateUploadUrl, verifyUploadedFile } = require('../services/storage.service');

// Issue M11 fix: containers-completed and milestones are two independent,
// independently-limited, independently-sorted sources merged in memory.
// The previous implementation applied one shared `before` cursor (derived
// from the last item of the merged, sliced page) to BOTH sources' next-page
// queries. That's not composable: if source A contributed more items to
// page 1 than source B, some of source B's already-fetched-but-unused
// items (dates between the merged cutoff and B's own fetch limit) would
// never be reachable on page 2 — a real skip, not just a theoretical one,
// once the two sources have an uneven split.
//
// Fixed with a per-source cursor instead of one shared cursor: the
// response now includes `next_cursor: { before_container, before_milestone }`
// reflecting exactly how far into EACH source this page consumed. The
// client passes both back verbatim for the next page instead of a single
// `before`. This keeps pagination exact without needing a heap-based
// streaming paginator or any server-side session state.
//
// FRONTEND DEPENDENCY: the timeline screen's "load more" must switch from
// passing a single `before` param to passing `before_container` and
// `before_milestone` from the previous response's `next_cursor`. Backward
// compatible for the FIRST page (a single legacy `before` is still
// accepted and applied to both sources, matching the old first-page
// behavior) — only pagination past page 1 needs the client update.

async function getTimeline(req, res, next) {
  try {
    const { workspaceId } = req.params;
    const limit  = Math.min(100, parseInt(req.query.limit) || 50);

    // Back-compat: a bare `before` still seeds both cursors (correct for
    // the first "load more" call); per-source cursors take precedence once
    // the client has them from a previous response.
    const beforeContainer = req.query.before_container || req.query.before;
    const beforeMilestone = req.query.before_milestone || req.query.before;

    let cQuery = supabaseAdmin
      .from('containers')
      .select('id, name, completed_at, outcome_details, outcome_files')
      .eq('workspace_id', workspaceId)
      .eq('status', 'completed')
      .is('deleted_at', null)
      .order('completed_at', { ascending: false })
      .limit(limit);

    if (beforeContainer) cQuery = cQuery.lt('completed_at', beforeContainer);

    let mQuery = supabaseAdmin
      .from('milestones')
      .select('id, title, description, milestone_date, photos')
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null)
      .order('milestone_date', { ascending: false })
      .limit(limit);

    if (beforeMilestone) mQuery = mQuery.lt('milestone_date', beforeMilestone);

    const [{ data: containers }, { data: milestones }] = await Promise.all([cQuery, mQuery]);

    const containerItems = (containers || []).map((c) => ({ type: 'container_completed', date: c.completed_at,    title: c.name,  description: c.outcome_details, photos: c.outcome_files, reference_id: c.id, reference_type: 'container' }));
    const milestoneItems = (milestones  || []).map((m) => ({ type: 'milestone',          date: m.milestone_date, title: m.title, description: m.description,     photos: m.photos,        reference_id: m.id, reference_type: 'milestone' }));

    const items = [...containerItems, ...milestoneItems]
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, limit);

    // The per-source cursor advances to the LAST item actually fetched
    // from that source (not the last item that made it into the merged,
    // sliced page) — so nothing fetched-but-unused is ever skipped on the
    // next call.
    const lastContainer = (containers  || [])[containers?.length  - 1];
    const lastMilestone = (milestones  || [])[milestones?.length  - 1];

    success(res, {
      items,
      next_cursor: {
        before_container: lastContainer?.completed_at    || null,
        before_milestone: lastMilestone?.milestone_date  || null,
      },
      has_more: (containers?.length === limit) || (milestones?.length === limit),
    });
  } catch (err) { next(err); }
}

async function createMilestone(req, res, next) {
  try {
    const data            = createMilestoneSchema.parse(req.body);
    const { workspaceId } = req.params;

    const { data: milestone, error } = await supabaseAdmin
      .from('milestones')
      .insert({ workspace_id: workspaceId, title: data.title, milestone_date: data.milestone_date, description: data.description || null, milestone_type: data.milestone_type, created_by: req.member.id })
      .select()
      .single();

    if (error) throw new Error(error.message);
    success(res, { milestone }, 201);
  } catch (err) { next(err); }
}

// ── Get single milestone ────────────────────────────────────────────

async function getMilestone(req, res, next) {
  try {
    const { workspaceId, milestoneId } = req.params;

    const { data: milestone, error } = await supabaseAdmin
      .from('milestones')
      .select('*')
      .eq('id', milestoneId)
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!milestone) throw new NotFoundError('Milestone not found');

    success(res, { milestone });
  } catch (err) { next(err); }
}

async function updateMilestone(req, res, next) {
  try {
    const data                        = updateMilestoneSchema.parse(req.body);
    const { workspaceId, milestoneId } = req.params;

    const updates = {};
    const allowed = ['title', 'description', 'milestone_date', 'milestone_type'];
    for (const f of allowed) { if (data[f] !== undefined) updates[f] = data[f]; }

    if (!Object.keys(updates).length) {
      const { data: m } = await supabaseAdmin.from('milestones').select('*').eq('id', milestoneId).single();
      return success(res, { milestone: m });
    }

    updates.updated_at = new Date().toISOString();

    const { data: milestone, error } = await supabaseAdmin
      .from('milestones').update(updates).eq('id', milestoneId).eq('workspace_id', workspaceId).is('deleted_at', null).select().maybeSingle();

    if (error) throw new Error(error.message);
    if (!milestone) throw new NotFoundError('Milestone not found');

    success(res, { milestone });
  } catch (err) { next(err); }
}

async function deleteMilestone(req, res, next) {
  try {
    const { workspaceId, milestoneId } = req.params;
    await supabaseAdmin.from('milestones').update({ deleted_at: new Date().toISOString() }).eq('id', milestoneId).eq('workspace_id', workspaceId);
    noContent(res);
  } catch (err) { next(err); }
}

async function getMilestonePhotoUploadUrl(req, res, next) {
  try {
    const data                        = uploadFileSchema.parse(req.body);
    const { workspaceId, milestoneId } = req.params;

    const result = await generateUploadUrl({ workspaceId, folder: `milestones/${milestoneId}`, filename: data.filename, contentType: data.content_type, fileSize: data.file_size, fileType: 'milestone_photo' });
    success(res, result);
  } catch (err) { next(err); }
}

async function confirmMilestonePhoto(req, res, next) {
  try {
    const data                        = confirmProofSchema.parse(req.body);
    const { workspaceId, milestoneId } = req.params;

    const { data: milestone } = await supabaseAdmin.from('milestones').select('*').eq('id', milestoneId).eq('workspace_id', workspaceId).is('deleted_at', null).maybeSingle();
    if (!milestone) throw new NotFoundError('Milestone not found');

    // Issue M13 fix: verify the uploaded file's actual bytes match its
    // declared content type before trusting it as a milestone photo.
    await verifyUploadedFile(data.file_path, data.mime_type);

    const fileObject    = { url: data.file_path, name: data.name, size: data.size, mime_type: data.mime_type, uploaded_by: req.member.id, uploaded_at: new Date().toISOString() };
    const currentPhotos = Array.isArray(milestone.photos) ? milestone.photos : [];

    const { data: updated, error } = await supabaseAdmin
      .from('milestones')
      .update({ photos: [...currentPhotos, fileObject], updated_at: new Date().toISOString() })
      .eq('id', milestoneId)
      .select()
      .single();

    if (error) throw new Error(error.message);
    success(res, { milestone: updated });
  } catch (err) { next(err); }
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
