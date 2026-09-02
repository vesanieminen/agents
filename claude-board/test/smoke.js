/**
 * End-to-end smoke test against the real GitHub API. Needs a classic PAT with
 * project + repo scopes in CLAUDE_BOARD_GITHUB_TOKEN. Creates (or reuses) the
 * repo + project, drives one synthetic session through every column, verifies
 * the issue and the board item, then closes and archives it.
 *
 *   CLAUDE_BOARD_GITHUB_TOKEN=... node test/smoke.js [--keep]
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig } from '../src/config.js';
import { GitHub } from '../src/github.js';
import { Store } from '../src/store.js';
import { Syncer } from '../src/sync.js';
import { apply } from '../src/machine.js';
import { findProject, createProject, ensureFields, writeProjectCache } from '../src/project.js';
import { labelDef } from '../src/render.js';
import { STATUS_META } from '../src/machine.js';

const log = (m) => console.log(`  ${m}`);
const keep = process.argv.includes('--keep');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-board-smoke-'));
const cfg = loadConfig({ ...process.env, CLAUDE_BOARD_DATA_DIR: dataDir, CLAUDE_BOARD_DRY_RUN: '' });
if (!cfg.token) { console.error('CLAUDE_BOARD_GITHUB_TOKEN missing'); process.exit(2); }

const gh = new GitHub({ token: cfg.token, apiBase: cfg.apiBase, log });
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? '✓' : '✗'} ${msg}`); if (!ok) failed++; };

console.log('\n# setup');
const { viewer, project: existing } = await findProject(gh, cfg.projectTitle);
check(!!viewer.login, `authenticated as ${viewer.login}`);
cfg.repo = cfg.repo || `${viewer.login}/claude-board`;
const [owner, name] = cfg.repo.split('/');
const repo = await gh.ensureRepo(owner, name, { isPrivate: true, description: 'Claude Code session board (maintained by claude-board)' });
check(repo?.full_name?.toLowerCase() === cfg.repo.toLowerCase(), `issues repo ${repo.html_url}`);
const project = existing || await createProject(gh, viewer.id, cfg.projectTitle);
check(!!project.id, `${existing ? 'reusing' : 'created'} project #${project.number} ${project.url}`);
const fields = await ensureFields(gh, project, { log });
check(Object.keys(fields.status.options).length >= 5, `Status options: ${Object.keys(fields.status.options).join(' · ')}`);
check(Object.keys(fields.custom).length === 6, `custom fields: ${Object.keys(fields.custom).join(' · ')}`);
for (const k of Object.keys(STATUS_META)) await gh.ensureLabel(cfg.repo, labelDef('status:' + k.replace('_', '-')));
writeProjectCache(dataDir, fields);
saveConfig(cfg, { repo: cfg.repo });

console.log('\n# one session through every column');
const store = new Store(dataDir, { log });
const syncer = new Syncer({ gh, cfg, store, project: fields, log });
const sid = 'smoke-' + Date.now().toString(36);
const ev = (n, extra = {}) => ({ session_id: sid, cwd: '/work/claude-board', permission_mode: 'acceptEdits', hook_event_name: n, ...extra });
let s = null; let now = Date.now();
const step = async (e, expect) => {
  now += 60000;
  s = apply(s, e, now); store.put(s); syncer.markDirty(sid);
  await syncer.flush();
  check(s.status === expect, `${e.hook_event_name}${e.notification_type ? '/' + e.notification_type : ''} → ${s.status}`);
};
await step({ ...ev('UserPromptSubmit', { prompt: 'Smoke test: walk a card across the board' }), __branch: 'main', model: 'claude-opus-5' }, 'working');
check(!!s.issue?.number, `issue #${s.issue?.number} ${s.issue?.url}`);
check(!!s.issue?.itemId, `board item ${s.issue?.itemId}`);
await step(ev('PostToolUse', { tool_name: 'Write', tool_input: { file_path: '/work/claude-board/src/x.js' }, tool_response: { gitDiff: { additions: 3, deletions: 1 } } }), 'working');
await step(ev('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }), 'needs_you');
await step(ev('UserPromptSubmit', { prompt: 'yes, go ahead' }), 'working');
await step(ev('StopFailure', { error_type: 'rate_limit', error: 'HTTP 429' }), 'errored');
await step(ev('Stop', { last_assistant_message: 'Smoke test complete.' }), 'done');

console.log('\n# verify on GitHub');
const issue = await gh.rest('GET', `/repos/${cfg.repo}/issues/${s.issue.number}`);
check(issue.title.startsWith('🟢'), `title: ${issue.title}`);
check(issue.labels.some(l => l.name === 'status:done'), `labels: ${issue.labels.map(l => l.name).join(' ')}`);
check(issue.body.includes(`claude --resume ${sid}`), 'body has resume command');
check(issue.body.includes('```mermaid'), 'body has mermaid timeline');
const item = await gh.graphql(`query($id: ID!) { node(id: $id) { ... on ProjectV2Item {
  status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
  turns: fieldValueByName(name: "Turns") { ... on ProjectV2ItemFieldNumberValue { number } }
  files: fieldValueByName(name: "Files touched") { ... on ProjectV2ItemFieldNumberValue { number } }
  branch: fieldValueByName(name: "Branch") { ... on ProjectV2ItemFieldTextValue { text } }
  session: fieldValueByName(name: "Session") { ... on ProjectV2ItemFieldTextValue { text } }
} } }`, { id: s.issue.itemId });
const n = item.node;
check(n.status?.name === 'Done', `board Status = ${n.status?.name}`);
check(n.turns?.number === 2, `Turns = ${n.turns?.number}`);
check(n.files?.number === 1, `Files touched = ${n.files?.number}`);
check(n.branch?.text === 'main', `Branch = ${n.branch?.text}`);
check(n.session?.text === sid, `Session = ${n.session?.text}`);

if (!keep) {
  console.log('\n# close + archive');
  await step(ev('SessionEnd', { reason: 'other' }), 'closed');
  const closed = await gh.rest('GET', `/repos/${cfg.repo}/issues/${s.issue.number}`);
  check(closed.state === 'closed', `issue #${closed.number} closed`);
  const arch = await gh.graphql(`query($id: ID!) { node(id: $id) { ... on ProjectV2Item { isArchived } } }`, { id: s.issue.itemId });
  check(arch.node?.isArchived === true, 'board item archived');
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
