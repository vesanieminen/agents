import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, sweepStale, sortForInbox } from '../src/machine.js';

const ev = (name, extra = {}) => ({ session_id: 'abc', cwd: '/w/repo-x', permission_mode: 'acceptEdits', hook_event_name: name, ...extra });
const T0 = 1_700_000_000_000;

test('first event creates a working session with repo from cwd', () => {
  const s = apply(null, ev('UserPromptSubmit', { prompt: 'do the thing' }), T0);
  assert.equal(s.status, 'working');
  assert.equal(s.repo, 'repo-x');
  assert.equal(s.turnCount, 1);
  assert.equal(s.currentPrompt, 'do the thing');
  assert.equal(s.permissionMode, 'acceptEdits');
});

test('needs_you on permission_prompt sets blockedSince once; prompt clears it', () => {
  let s = apply(null, ev('UserPromptSubmit', { prompt: 'x' }), T0);
  s = apply(s, ev('Notification', { notification_type: 'permission_prompt', message: 'Allow Bash?' }), T0 + 1000);
  assert.equal(s.status, 'needs_you');
  assert.equal(s.blockedSince, T0 + 1000);
  s = apply(s, ev('Notification', { notification_type: 'permission_prompt', message: 'again' }), T0 + 5000);
  assert.equal(s.blockedSince, T0 + 1000, 'blockedSince is not reset by repeat notifications');
  s = apply(s, ev('UserPromptSubmit', { prompt: 'yes' }), T0 + 9000);
  assert.equal(s.status, 'working');
  assert.equal(s.blockedSince, null);
});

test('idle_prompt does not move a done session to needs_you', () => {
  let s = apply(null, ev('UserPromptSubmit', { prompt: 'x' }), T0);
  s = apply(s, ev('Stop', { last_assistant_message: 'done' }), T0 + 1);
  s = apply(s, ev('Notification', { notification_type: 'idle_prompt', message: 'waiting' }), T0 + 60000);
  assert.equal(s.status, 'done');
  assert.equal(s.idle, true);
});

test('Stop records last message on the turn; StopFailure → errored; SessionEnd → closed', () => {
  let s = apply(null, ev('UserPromptSubmit', { prompt: 'x' }), T0);
  s = apply(s, ev('Stop', { last_assistant_message: 'all good' }), T0 + 1);
  assert.equal(s.status, 'done');
  assert.equal(s.turns[0].lastMessage, 'all good');
  s = apply(s, ev('StopFailure', { error_type: 'rate_limit', error: '429' }), T0 + 2);
  assert.equal(s.status, 'errored');
  assert.equal(s.lastError.type, 'rate_limit');
  s = apply(s, ev('SessionEnd', { reason: 'prompt_input_exit' }), T0 + 3);
  assert.equal(s.status, 'closed');
  assert.equal(s.endReason, 'prompt_input_exit');
});

test('PostToolUse on edit tools accumulates file stats with cwd-relative paths', () => {
  let s = apply(null, ev('UserPromptSubmit', { prompt: 'x' }), T0);
  const write = ev('PostToolUse', { tool_name: 'Write', tool_input: { file_path: '/w/repo-x/src/a.js' }, tool_response: { gitDiff: { additions: 5, deletions: 0 } } });
  s = apply(s, write, T0 + 1);
  s = apply(s, ev('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: '/w/repo-x/src/a.js' }, tool_response: { gitDiff: { additions: 1, deletions: 2 } } }), T0 + 2);
  s = apply(s, ev('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), T0 + 3);
  assert.deepEqual(s.files, { 'src/a.js': { adds: 6, dels: 2, ops: 2 } });
});

test('subagents and tasks are tracked', () => {
  let s = apply(null, ev('UserPromptSubmit', { prompt: 'x' }), T0);
  s = apply(s, ev('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }), T0 + 1);
  s = apply(s, ev('TaskCreated', { task_id: 't1', description: 'write tests' }), T0 + 2);
  s = apply(s, ev('TaskCompleted', { task_id: 't1' }), T0 + 3);
  s = apply(s, ev('SubagentStop', { agent_id: 'a1', agent_type: 'Explore' }), T0 + 4);
  assert.equal(s.subagents[0].endedAt, T0 + 4);
  assert.equal(s.tasks[0].done, true);
});

test('stale sweep flags silent working sessions; any event revives them', () => {
  const s = apply(null, ev('UserPromptSubmit', { prompt: 'x' }), T0);
  const sessions = { abc: s };
  assert.deepEqual(sweepStale(sessions, T0 + 5 * 60000, 10 * 60000), []);
  assert.deepEqual(sweepStale(sessions, T0 + 11 * 60000, 10 * 60000), ['abc']);
  assert.equal(sessions.abc.status, 'stale');
  const revived = apply(sessions.abc, ev('PostToolUse', { tool_name: 'Bash' }), T0 + 12 * 60000);
  assert.equal(revived.status, 'working');
});

test('surface header, branch and repo overrides are honoured', () => {
  const s = apply(null, { ...ev('UserPromptSubmit', { prompt: 'x' }), __surface: 'cloud', __branch: 'feat/a', __repo: 'from-remote' }, T0);
  assert.equal(s.surface, 'cloud');
  assert.equal(s.branch, 'feat/a');
  assert.equal(s.repo, 'from-remote');
});

test('inbox sort: needs_you longest-waiting first, then errored, stale, working, done', () => {
  const mk = (id, status, extra) => ({ id, status, lastEventAt: T0, blockedSince: null, ...extra });
  const list = [mk('d', 'done'), mk('w', 'working'), mk('n2', 'needs_you', { blockedSince: T0 - 1000 }), mk('e', 'errored'), mk('n1', 'needs_you', { blockedSince: T0 - 9000 }), mk('s', 'stale')];
  assert.deepEqual(sortForInbox(list, T0).map(x => x.id), ['n1', 'n2', 'e', 's', 'w', 'd']);
});
