import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/machine.js';
import { title, labels, body, labelDef, mermaidTimeline } from '../src/render.js';

const ev = (name, extra = {}) => ({ session_id: 'abc12345-0000', cwd: '/w/api-server', permission_mode: 'acceptEdits', hook_event_name: name, ...extra });
const T0 = 1_700_000_000_000;

function session() {
  let s = apply(null, { ...ev('UserPromptSubmit', { prompt: 'Add refresh-token rotation:\n  and tests' }), __branch: 'feat/auth', model: 'claude-opus-5' }, T0);
  s = apply(s, ev('PostToolUse', { tool_name: 'Write', tool_input: { file_path: '/w/api-server/src/auth.ts' }, tool_response: { gitDiff: { additions: 12, deletions: 3 } } }), T0 + 1000);
  s = apply(s, ev('Stop', { last_assistant_message: 'Rotation implemented; 4 tests added.' }), T0 + 90000);
  return s;
}

test('title carries emoji, repo, prompt snippet and branch on one line', () => {
  const t = title(session());
  assert.match(t, /^🟢 \[api-server\] Add refresh-token rotation: and tests · feat\/auth$/);
  assert.ok(!t.includes('\n'));
});

test('labels include status, repo, surface, mode, model', () => {
  assert.deepEqual(labels(session()), ['status:done', 'repo:api-server', 'surface:local', 'mode:acceptedits', 'model:opus']);
});

test('label definitions have 6-hex colors', () => {
  for (const n of ['status:needs-you', 'repo:x', 'surface:cloud', 'mode:plan', 'model:opus', 'unknown:thing']) {
    assert.match(labelDef(n).color, /^[0-9A-Fa-f]{6}$/, n);
  }
});

test('body contains marker, resume command, task, last message, files and timeline', () => {
  const b = body(session(), { now: T0 + 100000 });
  assert.ok(b.includes('<!-- claude-board:session=abc12345-0000 -->'));
  assert.ok(b.includes('claude --resume abc12345-0000'));
  assert.ok(b.includes('> Add refresh-token rotation: and tests'));
  assert.ok(b.includes('Rotation implemented; 4 tests added.'));
  assert.ok(b.includes('- `src/auth.ts` +12 −3'));
  assert.ok(b.includes('```mermaid\ntimeline'));
});

test('cloud sessions get a teleport command instead of resume', () => {
  const s = apply(null, { ...ev('UserPromptSubmit', { prompt: 'x' }), __surface: 'cloud' }, T0);
  assert.ok(body(s).includes('claude --teleport abc12345-0000'));
});

test('needs_you body shows waiting minutes and the notification', () => {
  let s = apply(null, ev('UserPromptSubmit', { prompt: 'x' }), T0);
  s = apply(s, ev('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }), T0);
  const b = body(s, { now: T0 + 7 * 60000 });
  assert.ok(/waiting since \*\*2023-11-14 22:13Z\*\*/.test(b), b.split('\n')[1]);
  assert.ok(b.includes('Claude needs your permission to use Bash'));
});

test('mermaid timeline strips characters that break the parser', () => {
  let s = apply(null, ev('UserPromptSubmit', { prompt: 'fix: bug #12 in `x`; see <y>' }), T0);
  const m = mermaidTimeline(s);
  const inner = m.split('\n').filter(l => !l.startsWith('```')).slice(2).join('\n').replace(/^\s*\d\d:\d\d :/gm, '');
  assert.ok(!/[:#;`<>]/.test(inner), inner);
});
