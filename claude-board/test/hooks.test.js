import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeHooks, removeHooks, renderHooks, EVENTS } from '../src/hooks.js';

const opts = { url: 'http://127.0.0.1:7777/event', surface: 'local' };

test('renderHooks covers every event with an http hook carrying our marker header', () => {
  const h = renderHooks(opts);
  assert.deepEqual(Object.keys(h).sort(), EVENTS.map(e => e.event).sort());
  assert.equal(h.PostToolUse[0].matcher, 'Edit|Write|MultiEdit|NotebookEdit');
  assert.equal(h.Stop[0].hooks[0].type, 'http');
  assert.equal(h.Stop[0].hooks[0].headers['X-Claude-Board'], '1');
  assert.equal(h.SessionEnd[0].hooks[0].timeout, 2);
});

test('cloud variant adds bearer header with env interpolation and allowedEnvVars', () => {
  const h = renderHooks({ url: 'https://t.example/event', surface: 'cloud', bearerEnv: 'CLAUDE_BOARD_TOKEN' });
  const e = h.Stop[0].hooks[0];
  assert.equal(e.headers.Authorization, 'Bearer $CLAUDE_BOARD_TOKEN');
  assert.deepEqual(e.allowedEnvVars, ['CLAUDE_BOARD_TOKEN']);
  assert.equal(e.headers['X-Claude-Board-Surface'], 'cloud');
});

test('merge preserves unrelated hooks and is idempotent', () => {
  const existing = { permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } };
  const once = mergeHooks(existing, opts);
  const twice = mergeHooks(once, opts);
  assert.deepEqual(twice, once);
  assert.equal(once.permissions.allow[0], 'Bash(ls)');
  assert.equal(once.hooks.Stop.length, 2);
  assert.equal(once.hooks.Stop[0].hooks[0].command, 'say done');
});

test('remove strips only ours', () => {
  const existing = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } };
  const merged = mergeHooks(existing, opts);
  const removed = removeHooks(merged);
  assert.deepEqual(removed, existing);
});
