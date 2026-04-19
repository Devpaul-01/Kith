// src/controllers/container.controller.js
const { supabaseAdmin }      = require('../config/supabase');
const { success, noContent } = require('../utils/response');
const { NotFoundError, BusinessRuleError } = require('../utils/errors');
const { createContainerSchema, updateContainerSchema, completeContainerSchema, convertToRecurringSchema } = require('../validators/workspace.validator');
const { generatePublicToken } = require('../utils/crypto');
const { generateUploadUrl }   = require('../services/storage.service');
const { uploadFileSchema }    = require('../validators/ledger.validator');
const notification = require('../services/notification.service');
const audit        = require('../services/audit.service');
const { getQueue } = require('../queues');

async function listContainers(req, res, next) {
  try {
    const { workspaceId } = req.params;
    const { sort }        = req.query;
    const typeFilter      = req.query['type'];
    const statusFilter    = req.query['status'];

    let query = supabaseAdmin
      .from('containers')
      .select('*, container_participants(id), ledger_entries(base_amount, status)')
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null);

    if (typeFilter)   query = query.eq('container_type', typeFilter);
    if (statusFilter) query = query.eq('status', statusFilter);

    const dir      = sort?.startsWith('-') ? false : true;
    const field    = sort?.replace('-', '') || 'created_at';
    const safeSort = ['created_at','name','event_date'].includes(field) ? field : 'created_at';
    query = query.order(safeSort, { ascending: dir });

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const containers = (data || []).map((c) => {
      const participants       = c.container_participants || [];
      const ledger             = c.ledger_entries || [];
      const totalConfirmedBase = ledger.filter((le) => le.status === 'confirmed').reduce((s, le) => s + parseFloat(le.base_amount || 0), 0);
      return { ...c, container_participants: undefined, ledger_entries: undefined, participant_count: participants.length, total_confirmed_base: totalConfirmedBase };
    });

    const activeCount = containers.filter((c) => c.status === 'active').length;
    success(res, { containers, meta: { total: containers.length, active_count: activeCount } });
  } catch (err) { next(err); }
}
/**
async function createContainer(req, res, next) {
  try {
    console.log("Container begin");
    const data          = createContainerSchema.parse(req.body);
    console.log("Contsiner aftet");
    const { workspaceId } = req.params;

    const { data: container, error } = await supabaseAdmin
      .from('containers')
      .insert({
        workspace_id: workspaceId, name: data.name, subtitle: data.subtitle || null,
        description: data.description || null, container_type: data.container_type,
        enable_money: data.enable_money, enable_tasks: data.enable_tasks,
        event_date: data.event_date || null, event_type: data.event_type || null,
        event_type_category: data.event_type_category,
        recurrence_cadence: data.recurrence_cadence || null, recurrence_days: data.recurrence_days || null,
        recurrence_start: data.recurrence_start || null, recurrence_end: data.recurrence_end || null,
        carry_forward_unpaid: data.carry_forward_unpaid,
        budget_target: data.budget_target || null, budget_currency: data.budget_currency || null,
        created_by: req.member.id,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    if (data.container_type === 'recurring') {
      await getQueue('cycle-generation-queue').add('generate-cycles', { container_id: container.id, generate_months_ahead: 3 }, { attempts: 3 });
    }

    success(res, { container }, 201);
  } catch (err) { next(err); }
}
*/
// src/controllers/container.controller.js
// ... (keep all existing imports)

async function createContainer(req, res, next) {
  try {
    console.log("=== CREATE CONTAINER START ===");
    console.log("Request body:", JSON.stringify(req.body, null, 2));
    console.log("Workspace ID from params:", req.params.workspaceId);
    console.log("Member from req:", req.member?.id);
    
    const { workspaceId } = req.params;
    const body = req.body;
    
    // ──────────────────────────────────────────────────────────
    // MANUAL VALIDATION WITH DETAILED LOGGING
    // ──────────────────────────────────────────────────────────
    const errors = [];
    
    // 1. Validate name
    if (!body.name) {
      errors.push({ field: 'name', message: 'Name is required' });
    } else if (typeof body.name !== 'string') {
      errors.push({ field: 'name', message: 'Name must be a string' });
    } else if (body.name.length < 2) {
      errors.push({ field: 'name', message: 'Name must be at least 2 characters' });
    } else if (body.name.length > 100) {
      errors.push({ field: 'name', message: 'Name must not exceed 100 characters' });
    }
    
    // 2. Validate container_type
    const validContainerTypes = ['event', 'recurring'];
    if (!body.container_type) {
      errors.push({ field: 'container_type', message: 'Container type is required' });
    } else if (!validContainerTypes.includes(body.container_type)) {
      errors.push({ field: 'container_type', message: `Container type must be one of: ${validContainerTypes.join(', ')}` });
    }
    
    // 3. Validate optional string fields
    const stringFields = ['subtitle', 'description', 'event_type'];
    for (const field of stringFields) {
      if (body[field] !== undefined && body[field] !== null && typeof body[field] !== 'string') {
        errors.push({ field, message: `${field} must be a string` });
      }
      if (body[field] && body[field].length > (field === 'description' ? 2000 : 200)) {
        errors.push({ field, message: `${field} exceeds maximum length` });
      }
    }
    
    // 4. Validate booleans
    const booleanFields = ['enable_money', 'enable_tasks', 'carry_forward_unpaid'];
    for (const field of booleanFields) {
      if (body[field] !== undefined && typeof body[field] !== 'boolean') {
        errors.push({ field, message: `${field} must be a boolean` });
      }
    }
    
    // Set defaults for booleans
    const enable_money = body.enable_money === undefined ? false : body.enable_money;
    const enable_tasks = body.enable_tasks === undefined ? false : body.enable_tasks;
    const carry_forward_unpaid = body.carry_forward_unpaid === undefined ? false : body.carry_forward_unpaid;
    
    // 5. Validate event_date format
    if (body.event_date !== undefined && body.event_date !== null) {
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(body.event_date)) {
        errors.push({ field: 'event_date', message: 'event_date must be in YYYY-MM-DD format' });
      } else {
        const date = new Date(body.event_date);
        if (isNaN(date.getTime())) {
          errors.push({ field: 'event_date', message: 'event_date is invalid' });
        }
      }
    }
    
    // 6. Validate event_type_category
    const validCategories = ['celebration', 'memorial', 'financial', 'logistical', 'other'];
    if (body.event_type_category && !validCategories.includes(body.event_type_category)) {
      errors.push({ field: 'event_type_category', message: `event_type_category must be one of: ${validCategories.join(', ')}` });
    }
    
    // 7. Validate budget
    if (body.budget_target !== undefined && body.budget_target !== null) {
      if (typeof body.budget_target !== 'number') {
        errors.push({ field: 'budget_target', message: 'budget_target must be a number' });
      } else if (body.budget_target <= 0) {
        errors.push({ field: 'budget_target', message: 'budget_target must be positive' });
      }
      
      if (!enable_money) {
        errors.push({ field: 'budget_target', message: 'budget_target requires enable_money=true' });
      }
    }
    
    // 8. Validate budget_currency
    const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'INR', 'BRL']; // Add your supported currencies
    if (body.budget_currency !== undefined && body.budget_currency !== null) {
      if (!SUPPORTED_CURRENCIES.includes(body.budget_currency)) {
        errors.push({ field: 'budget_currency', message: `Unsupported currency. Must be one of: ${SUPPORTED_CURRENCIES.join(', ')}` });
      }
    }
    
    // 9. Validate recurring-specific fields
    if (body.container_type === 'recurring') {
      const validCadences = ['monthly', 'weekly', 'quarterly', 'yearly', 'custom'];
      if (!body.recurrence_cadence) {
        errors.push({ field: 'recurrence_cadence', message: 'recurrence_cadence is required for recurring containers' });
      } else if (!validCadences.includes(body.recurrence_cadence)) {
        errors.push({ field: 'recurrence_cadence', message: `recurrence_cadence must be one of: ${validCadences.join(', ')}` });
      }
      
      if (body.recurrence_days !== undefined && body.recurrence_days !== null) {
        if (typeof body.recurrence_days !== 'number') {
          errors.push({ field: 'recurrence_days', message: 'recurrence_days must be a number' });
        } else if (body.recurrence_days < 1) {
          errors.push({ field: 'recurrence_days', message: 'recurrence_days must be at least 1' });
        }
      }
      
      if (!body.recurrence_start) {
        errors.push({ field: 'recurrence_start', message: 'recurrence_start is required for recurring containers' });
      } else {
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(body.recurrence_start)) {
          errors.push({ field: 'recurrence_start', message: 'recurrence_start must be in YYYY-MM-DD format' });
        }
      }
      
      if (body.recurrence_end !== undefined && body.recurrence_end !== null) {
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(body.recurrence_end)) {
          errors.push({ field: 'recurrence_end', message: 'recurrence_end must be in YYYY-MM-DD format' });
        }
      }
    }
    
    // Log all validation errors
    if (errors.length > 0) {
      console.error("Validation errors:", JSON.stringify(errors, null, 2));
      return res.status(400).json({ 
        error: 'Validation failed', 
        details: errors,
        received_body: body 
      });
    }
    
    console.log("✅ Manual validation passed");
    
    // ──────────────────────────────────────────────────────────
    // PREPARE DATA FOR DATABASE
    // ──────────────────────────────────────────────────────────
    const containerData = {
      workspace_id: workspaceId,
      name: body.name,
      subtitle: body.subtitle || null,
      description: body.description || null,
      container_type: body.container_type,
      enable_money: enable_money,
      enable_tasks: enable_tasks,
      event_date: body.event_date || null,
      event_type: body.event_type || null,
      event_type_category: body.event_type_category || 'other',
      recurrence_cadence: body.recurrence_cadence || null,
      recurrence_days: body.recurrence_days || null,
      recurrence_start: body.recurrence_start || null,
      recurrence_end: body.recurrence_end || null,
      carry_forward_unpaid: carry_forward_unpaid,
      budget_target: body.budget_target || null,
      budget_currency: body.budget_currency || null,
      created_by: req.member.id,
    };
    
    console.log("Inserting container with data:", JSON.stringify(containerData, null, 2));
    
    // ──────────────────────────────────────────────────────────
    // INSERT INTO DATABASE
    // ──────────────────────────────────────────────────────────
    const { data: container, error } = await supabaseAdmin
      .from('containers')
      .insert(containerData)
      .select()
      .single();
    
    if (error) {
      console.error("❌ Supabase insert error:", error);
      console.error("Error details:", {
        message: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint
      });
      throw new Error(`Database error: ${error.message}`);
    }
    
    console.log("✅ Container created successfully:", container.id);
    
    // ──────────────────────────────────────────────────────────
    // HANDLE RECURRING QUEUE
    // ──────────────────────────────────────────────────────────
    if (container.container_type === 'recurring') {
      console.log("Adding to cycle-generation-queue for container:", container.id);
      await getQueue('cycle-generation-queue').add('generate-cycles', 
        { container_id: container.id, generate_months_ahead: 3 }, 
        { attempts: 3 }
      );
    }
    
    console.log("=== CREATE CONTAINER END ===");
    success(res, { container }, 201);
    
  } catch (err) {
    console.error("❌ Unhandled error in createContainer:", err);
    console.error("Error stack:", err.stack);
    next(err);
  }
}

async function getContainer(req, res, next) {
  try {
    const { workspaceId, containerId } = req.params;

    const { data: container, error } = await supabaseAdmin
      .from('containers')
      .select(`
        id,
        workspace_id,
        name,
        subtitle,
        description,
        container_type,
        status,
        enable_money,
        enable_tasks,
        event_date,
        event_type,
        event_type_category,
        budget_target,
        budget_currency,
        recurrence_cadence,
        recurrence_days,
        recurrence_start,
        recurrence_end,
        carry_forward_unpaid,
        auto_generate_cycles,
        public_token,
        public_show_names,
        outcome_details,
        outcome_files,
        converted_from_id,
        created_by,
        created_at,
        updated_at,
        completed_at,
        deleted_at,
        container_participants(id)
      `)
      .eq('id', containerId)
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!container) throw new NotFoundError('Container not found');

    // Log what we're returning for debugging
    console.log('📦 getContainer response:', {
      id: container.id,
      name: container.name,
      budget_currency: container.budget_currency,
      event_type_category: container.event_type_category,
      enable_money: container.enable_money,
      enable_tasks: container.enable_tasks
    });

    const participantCount = (container.container_participants || []).length;

    let currentCycle = null;
    if (container.container_type === 'recurring') {
      const { data: cycle } = await supabaseAdmin
        .from('container_cycles')
        .select('*')
        .eq('container_id', containerId)
        .in('status', ['open', 'upcoming'])
        .order('cycle_start', { ascending: true })
        .limit(1)
        .maybeSingle();
      currentCycle = cycle || null;
    }

    const { data: participation } = await supabaseAdmin
      .from('container_participants')
      .select('*')
      .eq('container_id', containerId)
      .eq('workspace_member_id', req.member.id)
      .maybeSingle();

    // Remove container_participants from the response
    const { container_participants, ...cleanContainer } = container;

    success(res, {
      container: cleanContainer,
      current_cycle: currentCycle,
      tasks_enabled: container.enable_tasks,
      money_enabled: container.enable_money,
      participant_count: participantCount,
      current_user_participation: participation || null,
    });
  } catch (err) { 
    console.error('❌ getContainer error:', err);
    next(err); 
  }
}

async function updateContainer(req, res, next) {
  try {
    const data                          = updateContainerSchema.parse(req.body);
    const { workspaceId, containerId }  = req.params;

    const { data: current, error: fetchErr } = await supabaseAdmin
      .from('containers').select('*').eq('id', containerId).eq('workspace_id', workspaceId).is('deleted_at', null).maybeSingle();

    if (fetchErr) throw new Error(fetchErr.message);
    if (!current) throw new NotFoundError('Container not found');

    if (data.enable_money === false && current.enable_money === true) {
      const { count } = await supabaseAdmin.from('ledger_entries').select('*', { count: 'exact', head: true }).eq('container_id', containerId);
      if (count > 0) throw new BusinessRuleError('Cannot disable money tracking — ledger entries exist');
    }

    // ✅ Add cover_photos to allowed fields
    const allowedFields = [
      'name', 'subtitle', 'description', 'event_date', 'event_type', 
      'event_type_category', 'budget_target', 'budget_currency', 
      'public_show_names', 'carry_forward_unpaid', 'recurrence_end', 
      'enable_tasks', 'enable_money', 'cover_photos'  // ← Add this
    ];
    
    const updates = {};
    for (const field of allowedFields) {
      if (data[field] !== undefined) updates[field] = data[field];
    }

    if (!Object.keys(updates).length) return success(res, { container: current });

    updates.updated_at = new Date().toISOString();

    const { data: container, error } = await supabaseAdmin
      .from('containers').update(updates).eq('id', containerId).select().single();

    if (error) throw new Error(error.message);
    success(res, { container });
  } catch (err) { next(err); }
}

async function completeContainer(req, res, next) {
  try {
    const data                          = completeContainerSchema.parse(req.body);
    const { workspaceId, containerId }  = req.params;

    const { data: container, error: fetchErr } = await supabaseAdmin
      .from('containers').select('*').eq('id', containerId).eq('workspace_id', workspaceId).is('deleted_at', null).maybeSingle();

    if (fetchErr) throw new Error(fetchErr.message);
    if (!container) throw new NotFoundError('Container not found');
    if (container.status !== 'active') throw new BusinessRuleError('Only active containers can be completed');

    const now = new Date().toISOString();

    const { data: updated, error: updateErr } = await supabaseAdmin
      .from('containers')
      .update({ status: 'completed', completed_at: now, outcome_details: data.outcome_details || null, outcome_files: data.outcome_files, updated_at: now })
      .eq('id', containerId)
      .select()
      .single();

    if (updateErr) throw new Error(updateErr.message);

    // Auto-create milestone
    console.log('\n📝 Creating milestone for completed container...');
    const milestoneTitle = `${container.name} completed`;
    const milestoneDate = now.split('T')[0];
    
    const { data: insertedMilestone, error: milestoneInsertError } = await supabaseAdmin
      .from('milestones')
      .insert({
        workspace_id: workspaceId, 
        title: milestoneTitle,
        milestone_date: milestoneDate, 
        description: data.outcome_details || null,
        milestone_type: 'custom', 
        created_by: req.member.id,
      })
      .select()
      .single();

    if (milestoneInsertError) {
      console.error('❌ Failed to create milestone:', milestoneInsertError);
    } else {
      console.log('✅ Milestone created successfully:', {
        id: insertedMilestone.id,
        title: insertedMilestone.title,
        milestone_date: insertedMilestone.milestone_date,
        workspace_id: insertedMilestone.workspace_id,
        created_by: insertedMilestone.created_by,
      });
    }

    // Verify milestone exists in database
    console.log('\n🔍 Verifying milestone was saved...');
    const { data: verifyMilestone, error: verifyError } = await supabaseAdmin
      .from('milestones')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('title', milestoneTitle)
      .order('created_at', { ascending: false })
      .limit(1);

    if (verifyError) {
      console.error('❌ Failed to verify milestone:', verifyError);
    } else if (verifyMilestone && verifyMilestone.length > 0) {
      console.log('✅ Milestone verified in database:', {
        found: true,
        count: verifyMilestone.length,
        latest: {
          id: verifyMilestone[0].id,
          title: verifyMilestone[0].title,
          milestone_date: verifyMilestone[0].milestone_date,
          created_at: verifyMilestone[0].created_at,
        }
      });
    } else {
      console.log('❌ No milestone found with title:', milestoneTitle);
    }

    // Notify participants
    const { data: participants } = await supabaseAdmin
      .from('container_participants').select('workspace_member_id').eq('container_id', containerId);

    await notification.send({ type: 'container_completed', workspaceId, recipientIds: (participants || []).map((p) => p.workspace_member_id), referenceType: 'container', referenceId: containerId, variables: { container: container.name } });

    await audit.log({ ...audit.fromReq(req), action: 'container.completed', targetType: 'container', targetId: containerId });

    success(res, { container: updated });
  } catch (err) { next(err); }
}

async function convertToRecurring(req, res, next) {
  try {
    const data                          = convertToRecurringSchema.parse(req.body);
    const { workspaceId, containerId }  = req.params;

    const { data: source, error: fetchErr } = await supabaseAdmin
      .from('containers').select('*').eq('id', containerId).eq('workspace_id', workspaceId).is('deleted_at', null).maybeSingle();

    if (fetchErr) throw new Error(fetchErr.message);
    if (!source) throw new NotFoundError('Container not found');
    if (source.container_type !== 'event') throw new BusinessRuleError('Only event containers can be converted to recurring');
    if (!['active','completed'].includes(source.status)) throw new BusinessRuleError('Container must be active or completed to convert');

    const { data: newContainer, error: newErr } = await supabaseAdmin
      .from('containers')
      .insert({
        workspace_id: workspaceId, name: data.new_name || source.name, container_type: 'recurring',
        enable_money: source.enable_money, enable_tasks: source.enable_tasks,
        recurrence_cadence: data.recurrence_cadence, recurrence_days: data.recurrence_days || null,
        recurrence_start: data.recurrence_start, recurrence_end: data.recurrence_end || null,
        carry_forward_unpaid: data.carry_forward_unpaid, budget_currency: source.budget_currency,
        converted_from_id: containerId, created_by: req.member.id,
      })
      .select()
      .single();

    if (newErr) throw new Error(newErr.message);

    // Copy participants
    const { data: oldParticipants } = await supabaseAdmin
      .from('container_participants').select('workspace_member_id, money_enabled, tasks_enabled').eq('container_id', containerId);

    if ((oldParticipants || []).length) {
      await supabaseAdmin.from('container_participants').upsert(
        (oldParticipants || []).map((p) => ({ container_id: newContainer.id, workspace_member_id: p.workspace_member_id, money_enabled: p.money_enabled, tasks_enabled: p.tasks_enabled, added_by: req.member.id })),
        { ignoreDuplicates: true }
      );
    }

    await getQueue('cycle-generation-queue').add('generate-cycles', { container_id: newContainer.id, generate_months_ahead: 3 }, { attempts: 3 });

    await audit.log({ ...audit.fromReq(req), action: 'container.converted_to_recurring', targetType: 'container', targetId: newContainer.id, metadata: { source_container_id: containerId } });

    success(res, { new_container: newContainer, source_container_id: containerId }, 201);
  } catch (err) { next(err); }
}

async function archiveContainer(req, res, next) {
  try {
    const { workspaceId, containerId } = req.params;

    const { data, error } = await supabaseAdmin
      .from('containers')
      .update({ status: 'archived', updated_at: new Date().toISOString() })
      .eq('id', containerId)
      .eq('workspace_id', workspaceId)
      .in('status', ['active','completed'])
      .is('deleted_at', null)
      .select()
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundError('Container not found or cannot be archived');

    await audit.log({ ...audit.fromReq(req), action: 'container.archived', targetType: 'container', targetId: containerId });

    success(res, { container: data });
  } catch (err) { next(err); }
}

async function generatePublicLink(req, res, next) {
  try {
    const { workspaceId, containerId } = req.params;
    const token = generatePublicToken();

    const { data, error } = await supabaseAdmin
      .from('containers')
      .update({ public_token: token, updated_at: new Date().toISOString() })
      .eq('id', containerId)
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null)
      .select('public_token')
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundError('Container not found');

    success(res, { public_url: `${process.env.FRONTEND_URL}/event/${token}`, public_token: token });
  } catch (err) { next(err); }
}

async function deleteContainer(req, res, next) {
  try {
    const { workspaceId, containerId } = req.params;

    const { count } = await supabaseAdmin
      .from('ledger_entries').select('*', { count: 'exact', head: true }).eq('container_id', containerId).eq('status', 'confirmed');

    if (count > 0) throw new BusinessRuleError('Cannot delete a container with confirmed ledger entries');

    await supabaseAdmin.from('containers').update({ deleted_at: new Date().toISOString() }).eq('id', containerId).eq('workspace_id', workspaceId);

    await audit.log({ ...audit.fromReq(req), action: 'container.deleted', targetType: 'container', targetId: containerId });

    success(res, { message: 'Container archived.' });
  } catch (err) { next(err); }
}

async function getSummary(req, res, next) {
  try {
    console.log('\n========== GET SUMMARY START ==========');
    const { workspaceId, containerId } = req.params;
    const isAdmin = req.member.role === 'admin';
    const callerId = req.member.id;

    console.log('📋 Request params:', { workspaceId, containerId, isAdmin, callerId });

    // 1. Fetch container
    console.log('🔍 Fetching container...');
    const { data: container, error: cErr } = await supabaseAdmin
      .from('containers')
      .select('id, name, status, budget_target, budget_currency, enable_money')
      .eq('id', containerId)
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null)
      .maybeSingle();

    if (cErr) {
      console.error('❌ Container fetch error:', cErr);
      throw new Error(cErr.message);
    }
    if (!container) {
      console.error('❌ Container not found');
      throw new NotFoundError('Container not found');
    }
    console.log('✅ Container found:', { id: container.id, name: container.name, enable_money: container.enable_money });

    // 2. Fetch participants - FIXED: Specify the correct foreign key relationship
    console.log('🔍 Fetching participants for container:', containerId);
    const { data: participants, error: pErr } = await supabaseAdmin
      .from('container_participants')
      .select(`
        id, 
        role, 
        money_enabled, 
        workspace_member_id,
        added_by,
        workspace_members!container_participants_workspace_member_id_fkey (
          display_name, 
          is_proxy
        ),
        contributor_targets(
          target_amount, 
          target_currency, 
          due_date, 
          is_current, 
          cycle_id
        )
      `)
      .eq('container_id', containerId);

    if (pErr) {
      console.error('❌ Participants fetch error:', pErr);
      throw new Error(pErr.message);
    }
    
    console.log(`📊 Participants found: ${participants?.length || 0}`);
    if (participants && participants.length > 0) {
      console.log('📝 First participant sample:', JSON.stringify(participants[0], null, 2));
    } else {
      console.warn('⚠️ NO participants found for this container!');
    }

    // 3. Fetch ledger entries
    console.log('🔍 Fetching ledger entries for container:', containerId);
    const { data: ledger, error: lErr } = await supabaseAdmin
      .from('ledger_entries')
      .select('contributor_id, base_amount, status')
      .eq('container_id', containerId);

    if (lErr) {
      console.error('❌ Ledger fetch error:', lErr);
      throw new Error(lErr.message);
    }
    
    console.log(`📊 Ledger entries found: ${ledger?.length || 0}`);
    if (ledger && ledger.length > 0) {
      console.log('📝 Ledger summary:', {
        total_entries: ledger.length,
        confirmed_count: ledger.filter(l => l.status === 'confirmed').length,
        total_base_amount: ledger.reduce((sum, l) => sum + parseFloat(l.base_amount || 0), 0)
      });
    } else {
      console.warn('⚠️ NO ledger entries found for this container!');
    }

    // 4. Shape participants
    console.log('🔄 Shaping participants data...');
    const shapedParticipants = (participants || []).map((p) => {
      const member = p.workspace_members;
      const currentTarget = (p.contributor_targets || []).find((t) => t.is_current && t.cycle_id === null);
      const entries = (ledger || []).filter((le) => le.contributor_id === p.workspace_member_id);
      const confirmed = entries.filter((le) => le.status === 'confirmed').reduce((s, le) => s + parseFloat(le.base_amount || 0), 0);
      const pending = entries.filter((le) => ['pending', 'proof_uploaded'].includes(le.status)).reduce((s, le) => s + parseFloat(le.base_amount || 0), 0);
      const target = parseFloat(currentTarget?.target_amount || 0);
      const outstanding = Math.max(0, target - confirmed);

      let status = 'no_target';
      if (target > 0) {
        if (confirmed >= target) status = 'paid';
        else if (confirmed > 0) status = 'partial';
        else if (currentTarget?.due_date && new Date(currentTarget.due_date) < new Date()) status = 'overdue';
        else status = 'pending';
      }

      console.log(`  📝 Participant ${member?.display_name}:`, {
        workspace_member_id: p.workspace_member_id,
        has_target: !!currentTarget,
        target_amount: target,
        confirmed_amount: confirmed,
        pending_amount: pending,
        status,
        is_admin_view: isAdmin,
        is_owner: p.workspace_member_id === callerId
      });

      const full = {
        member_id: p.workspace_member_id,
        display_name: member?.display_name,
        is_proxy: member?.is_proxy,
        role: p.role,
        status,
        current_target: currentTarget ? {
          amount: currentTarget.target_amount,
          currency: currentTarget.target_currency,
          due_date: currentTarget.due_date
        } : null,
        confirmed_paid_base: confirmed,
        pending_paid_base: pending,
        outstanding_base: outstanding,
      };

      // For non-admins, only show limited info for other members
      if (!isAdmin && p.workspace_member_id !== callerId) {
        console.log(`    🔒 Limited view for non-admin user`);
        return {
          member_id: p.workspace_member_id,
          display_name: member?.display_name,
          is_proxy: member?.is_proxy,
          role: p.role,
          status
        };
      }
      return full;
    });

    console.log(`✅ Shaped ${shapedParticipants.length} participants`);

    // 5. Calculate totals
    const totalExpected = shapedParticipants.reduce((s, p) => s + parseFloat(p.current_target?.amount || 0), 0);
    const totalConfirmed = shapedParticipants.reduce((s, p) => s + (p.confirmed_paid_base || 0), 0);
    const totalPending = shapedParticipants.reduce((s, p) => s + (p.pending_paid_base || 0), 0);
    const progressPct = totalExpected > 0 ? Math.round((totalConfirmed / totalExpected) * 100) : null;

    console.log('📊 Calculated totals:', {
      totalExpected,
      totalConfirmed,
      totalPending,
      progressPct,
      participantCount: shapedParticipants.length
    });

    // 6. Prepare response
    const response = {
      container,
      total_expected_base: totalExpected,
      total_confirmed_base: totalConfirmed,
      total_pending_base: totalPending,
      progress_pct: progressPct,
      participants: shapedParticipants
    };

    console.log('📤 Response summary:', {
      has_container: !!response.container,
      participants_count: response.participants.length,
      total_confirmed: response.total_confirmed_base,
      total_expected: response.total_expected_base
    });
    console.log('========== GET SUMMARY END ==========\n');

    success(res, response);
  } catch (err) {
    console.error('💥 GetSummary error:', err);
    console.error('Stack trace:', err.stack);
    next(err);
  }
}
async function listCycles(req, res, next) {
  try {
    const { containerId } = req.params;
    const statusFilter    = req.query['status'];
    const page    = parseInt(req.query.page) || 1;
    const perPage = Math.min(100, parseInt(req.query.per_page) || 20);
    const offset  = (page - 1) * perPage;

    let query = supabaseAdmin.from('container_cycles').select('*', { count: 'exact' }).eq('container_id', containerId).order('cycle_number', { ascending: false }).range(offset, offset + perPage - 1);
    if (statusFilter) query = query.eq('status', statusFilter);

    const { data, error, count } = await query;
    if (error) throw new Error(error.message);

    success(res, { cycles: data || [], meta: { total: count || 0, pagination: { page, per_page: perPage } } });
  } catch (err) { next(err); }
}

async function generateOutcomeFileUploadUrl(req, res, next) {
  try {
    const data = uploadFileSchema.parse(req.body);
    const { workspaceId, containerId } = req.params;
    const result = await generateUploadUrl({ workspaceId, folder: `outcome/${containerId}`, filename: data.filename, contentType: data.content_type, fileSize: data.file_size, fileType: 'outcome_file' });
    success(res, result);
  } catch (err) { next(err); }
}

async function generateCoverPhotoUploadUrl(req, res, next) {
  try {
    const data = uploadFileSchema.parse(req.body);
    const { workspaceId, containerId } = req.params;
    const result = await generateUploadUrl({ workspaceId, folder: `covers/${containerId}`, filename: data.filename, contentType: data.content_type, fileSize: data.file_size, fileType: 'cover_photo' });
    success(res, result);
  } catch (err) { next(err); }
}

async function getPublicContainer(req, res, next) {
  try {
    const { publicToken } = req.params;

    const { data: container, error } = await supabaseAdmin
      .from('containers')
      .select('*, workspaces!inner(name)')
      .eq('public_token', publicToken)
      .is('deleted_at', null)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!container) throw new NotFoundError('Public page not found');

    const { data: ledger } = await supabaseAdmin
      .from('ledger_entries').select('base_amount').eq('container_id', container.id).eq('status', 'confirmed');

    const total       = (ledger || []).reduce((s, le) => s + parseFloat(le.base_amount || 0), 0);
    const progressPct = container.budget_target ? Math.round((total / container.budget_target) * 100) : null;

    const response = {
      name: container.name, subtitle: container.subtitle, event_date: container.event_date,
      budget_target: container.budget_target, budget_currency: container.budget_currency,
      total_confirmed_base: total, progress_pct: progressPct,
      workspace_name: container.workspaces?.name,
    };

    if (container.public_show_names) {
      const { data: participants } = await supabaseAdmin
        .from('container_participants')
        .select('workspace_member_id, workspace_members(display_name), contributor_targets(target_amount, is_current)')
        .eq('container_id', container.id)
        .eq('exclude_from_public', false)
        .eq('money_enabled', true);

      response.contributors = (participants || []).map((p) => {
        const paidAmount = (ledger || []).filter((le) => le.contributor_id === p.workspace_member_id).reduce((s, le) => s + parseFloat(le.base_amount || 0), 0);
        const target     = parseFloat((p.contributor_targets || []).find((t) => t.is_current)?.target_amount || 0);
        return { display_name: p.workspace_members?.display_name, status: paidAmount >= target ? 'paid' : 'pending' };
      });
    }

    success(res, response);
  } catch (err) { next(err); }
}
// Add this temporary debug endpoint in container.controller.js
async function debugContainerData(req, res, next) {
  try {
    const { workspaceId, containerId } = req.params;
    
    // Get participants count
    const { data: participants, error: pErr } = await supabaseAdmin
      .from('container_participants')
      .select('id, workspace_member_id')
      .eq('container_id', containerId);
    
    // Get ledger entries count and total
    const { data: ledger, error: lErr } = await supabaseAdmin
      .from('ledger_entries')
      .select('contributor_id, status, base_amount')
      .eq('container_id', containerId);
    
    // Get workspace members that have contributed
    const contributorIds = [...new Set((ledger || []).map(l => l.contributor_id))];
    const { data: members } = await supabaseAdmin
      .from('workspace_members')
      .select('id, display_name')
      .in('id', contributorIds);
    
    res.json({
      container_id: containerId,
      participants_count: participants?.length || 0,
      participants_list: participants,
      ledger_count: ledger?.length || 0,
      ledger_confirmed_count: ledger?.filter(l => l.status === 'confirmed').length || 0,
      ledger_total_base: ledger?.reduce((sum, l) => sum + parseFloat(l.base_amount || 0), 0) || 0,
      unique_contributors: contributorIds.length,
      contributor_details: members,
      has_missing_participants: contributorIds.length > (participants?.length || 0)
    });
  } catch (err) {
    next(err);
  }
}

// Add to exports

module.exports = { listContainers, createContainer, getContainer, updateContainer, completeContainer, convertToRecurring, archiveContainer, generatePublicLink, deleteContainer, getSummary, listCycles, generateOutcomeFileUploadUrl,debugContainerData, generateCoverPhotoUploadUrl, getPublicContainer };
