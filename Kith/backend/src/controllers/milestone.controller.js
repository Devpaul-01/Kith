// src/controllers/milestone.controller.js
const { supabaseAdmin }      = require('../config/supabase');
const { success, noContent } = require('../utils/response');
const { NotFoundError }      = require('../utils/errors');
const { createMilestoneSchema, updateMilestoneSchema, uploadFileSchema, confirmProofSchema } = require('../validators/ledger.validator');
const { generateUploadUrl } = require('../services/storage.service');

async function getTimeline(req, res, next) {
  try {
    const { workspaceId } = req.params;
    const limit  = Math.min(100, parseInt(req.query.limit) || 50);
    const before = req.query.before;

    let cQuery = supabaseAdmin
      .from('containers')
      .select('id, name, completed_at, outcome_details, outcome_files')
      .eq('workspace_id', workspaceId)
      .eq('status', 'completed')
      .is('deleted_at', null)
      .order('completed_at', { ascending: false })
      .limit(limit);

    if (before) cQuery = cQuery.lt('completed_at', before);

    let mQuery = supabaseAdmin
      .from('milestones')
      .select('id, title, description, milestone_date, photos')
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null)
      .order('milestone_date', { ascending: false })
      .limit(limit);

    if (before) mQuery = mQuery.lt('milestone_date', before);

    const [{ data: containers }, { data: milestones }] = await Promise.all([cQuery, mQuery]);

    const containerItems = (containers || []).map((c) => ({ type: 'container_completed', date: c.completed_at,    title: c.name,  description: c.outcome_details, photos: c.outcome_files, reference_id: c.id, reference_type: 'container' }));
    const milestoneItems = (milestones  || []).map((m) => ({ type: 'milestone',          date: m.milestone_date, title: m.title, description: m.description,     photos: m.photos,        reference_id: m.id, reference_type: 'milestone' }));

    const items = [...containerItems, ...milestoneItems]
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, limit);

    success(res, { items });
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

// ── Get single milestone (Issue 5.7) ──────────────────────────────
//
// Issue 5.7 fix: this function was missing entirely. The route
// GET /milestones/:milestoneId was declared but called a non-existent
// export, causing a runtime "msCtrl.getMilestone is not a function" crash
// on every request to that endpoint.

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
  getMilestone,          // Issue 5.7: was missing — added
  updateMilestone,
  deleteMilestone,
  getMilestonePhotoUploadUrl,
  confirmMilestonePhoto,
};
