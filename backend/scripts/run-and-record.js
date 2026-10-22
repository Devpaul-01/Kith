#!/usr/bin/env node
// scripts/run-and-record.js
//
// Runs a measurement script as a child process and writes a single
// timestamped, machine-readable result file capturing both the metadata
// needed to reproduce the run and the script's raw output. Deliberately
// generic and separate from the experiment scripts themselves (measure.js,
// target-race-report.js, idempotency-race.js, immutability-trigger.js) so
// none of them need to know about result-file formatting.
//
// Usage:
//   node scripts/run-and-record.js <experiment_name> <results_subdir> -- <command> [args...]
//
// Example:
//   node scripts/run-and-record.js M4_membership_cache cache -- \
//     node scripts/measure.js cache 300
//
// Output: scripts/results/<results_subdir>/<experiment_name>_<run_id>.json
// Never overwrites a previous run — every invocation gets a fresh
// UTC-timestamp + random-suffix run ID.
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const args = process.argv.slice(2);
const dashIdx = args.indexOf('--');
if (dashIdx === -1 || dashIdx < 2) {
  console.error('usage: node scripts/run-and-record.js <experiment_name> <results_subdir> -- <command> [args...]');
  process.exit(1);
}
const [experimentName, resultsSubdir] = args.slice(0, dashIdx);
const command = args.slice(dashIdx + 1);

function sh(cmd, fallback = null) {
  try { return execSync(cmd, { cwd: path.join(__dirname, '..', '..'), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return fallback; }
}

const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}_${crypto.randomBytes(3).toString('hex')}`;
const startedAt = new Date().toISOString();

const result = spawnSync(command[0], command.slice(1), {
  cwd: path.join(__dirname, '..'),
  env: process.env,
  encoding: 'utf8',
  timeout: 10 * 60 * 1000,
});

const finishedAt = new Date().toISOString();

const record = {
  experiment_name: experimentName,
  run_id: runId,
  started_at_utc: startedAt,
  finished_at_utc: finishedAt,
  repository: {
    commit_sha: sh('git rev-parse HEAD'),
    branch: sh('git rev-parse --abbrev-ref HEAD'),
    dirty: sh('git status --porcelain') ? true : false,
  },
  runtime: {
    node_version: process.version,
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpus: os.cpus().length,
    cpu_model: (os.cpus()[0] || {}).model || 'unavailable',
    total_memory_mb: Math.round(os.totalmem() / 1024 / 1024),
  },
  command: command.join(' '),
  exit_code: result.status,
  signal: result.signal,
  timed_out: !!result.error && result.error.code === 'ETIMEDOUT',
  stdout: result.stdout,
  stderr: result.stderr,
};

const outDir = path.join(__dirname, 'results', resultsSubdir);
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `${experimentName}_${runId}.json`);
fs.writeFileSync(outPath, JSON.stringify(record, null, 2));

console.log(result.stdout);
if (result.stderr) console.error(result.stderr);
console.log(`\n[run-and-record] saved -> ${path.relative(process.cwd(), outPath)}`);
process.exit(result.status || 0);
