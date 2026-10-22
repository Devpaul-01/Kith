#!/usr/bin/env node
// scripts/seed-measurement-fixtures.js
//
// Seeds one disposable workspace + admin member + container + participant
// against whatever SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY .env.measurement
// points at (the local test stack — see scripts/local-test-stack/). Prints
// the IDs that scripts/measure.js's `cache` and `target-race` commands
// need as env vars. Safe to re-run — each run creates fresh rows and
// prints a fresh set of IDs; nothing here touches existing data.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.measurement') });
const { supabaseAdmin: db } = require('../src/config/supabase');
const { buildWorkspace, buildUser, buildMember, buildContainer, buildParticipant } = require('../tests/fixtures/factories');

(async () => {
  const { data: user, error: uErr } = await db.from('users').insert(buildUser()).select().single();
  if (uErr) throw new Error(`user insert failed: ${uErr.message}`);

  const { data: workspace, error: wErr } = await db.from('workspaces').insert(buildWorkspace({ created_by: user.id })).select().single();
  if (wErr) throw new Error(`workspace insert failed: ${wErr.message}`);

  const { data: member, error: mErr } = await db.from('workspace_members')
    .insert(buildMember({ workspace_id: workspace.id, user_id: user.id, role: 'admin' })).select().single();
  if (mErr) throw new Error(`member insert failed: ${mErr.message}`);

  const { data: container, error: cErr } = await db.from('containers')
    .insert(buildContainer({ workspace_id: workspace.id, created_by: member.id })).select().single();
  if (cErr) throw new Error(`container insert failed: ${cErr.message}`);

  const { data: participant, error: pErr } = await db.from('container_participants')
    .insert(buildParticipant({ container_id: container.id, workspace_member_id: member.id })).select().single();
  if (pErr) throw new Error(`participant insert failed: ${pErr.message}`);

  console.log(JSON.stringify({
    WORKSPACE_ID: workspace.id,
    USER_ID: user.id,
    MEMBER_ID: member.id,
    CONTAINER_ID: container.id,
    PARTICIPANT_ID: participant.id,
    SET_BY: member.id,
  }, null, 2));
})().catch((e) => { console.error('SEED FAILED:', e.message); process.exit(1); });
