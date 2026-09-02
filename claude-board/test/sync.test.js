import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Syncer } from '../src/sync.js';
import { apply } from '../src/machine.js';

const project = {
  id: 'P', url: 'https://example/p',
  status: { id: 'F_STATUS', options: { Working: 'O_W', 'Needs you': 'O_N', Errored: 'O_E', Done: 'O_D', Stale: 'O_S' } },
  custom: { 'Waiting (min)': 'F_WAIT', 'Last activity': 'F_LAST', 'Turns': 'F_TURNS', 'Files touched': 'F_FILES', 'Branch': 'F_BRANCH', 'Session': 'F_SESSION' },
};

/** GitHub double that records calls. */
function fakeGh() {
  const calls = [];
  return {
    calls,
    ensureLabel: async () => true,
    findIssueBySession: async () => null,
    createIssue: async (repo, x) => { calls.push(['createIssue', x.title]); return { number: 7, html_url: 'https://example/i/7', node_id: 'I_7' }; },
    updateIssue: async (repo, n, patch) => { calls.push(['updateIssue', n, Object.keys(patch).sort().join(',')]); return {}; },
    listComments: async () => [],
    graphql: async (q, vars) => {
      if (q.includes('addProjectV2ItemById')) { calls.push(['addItem']); return { addProjectV2ItemById: { item: { id: 'ITEM' } } }; }
      if (q.includes('archiveProjectV2Item')) { calls.push(['archive']); return {}; }
      const n = (q.match(/updateProjectV2ItemFieldValue/g) || []).length;
      calls.push(['setFields', n, Object.keys(vars).filter(k => k.startsWith('f')).map(k => vars[k]).sort()]);
      return {};
    },
  };
}

const T0 = 1_700_000_000_000;
const ev = (n, extra = {}) => ({ session_id: 'sess-1', cwd: '/w/repo', permission_mode: 'default', hook_event_name: n, ...extra });
const mk = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-'));
  const store = new Store(dir);
  const gh = fakeGh();
  const syncer = new Syncer({ gh, cfg: { repo: 'o/r', syncMs: 10, dryRun: false }, store, project });
  return { store, gh, syncer };
};

test('first sync creates the issue, adds the item and writes every field once', async () => {
  const { store, gh, syncer } = mk();
  const s = apply(null, { ...ev('UserPromptSubmit', { prompt: 'hi' }), __branch: 'main' }, T0);
  store.put(s); syncer.markDirty(s.id); await syncer.flush();
  assert.deepEqual(gh.calls.map(c => c[0]), ['createIssue', 'addItem', 'setFields']);
  assert.equal(gh.calls[2][1], 7, 'status + 6 custom fields');
});

test('a no-op resync sends nothing; a waiting-minutes tick sends only the changed field', async () => {
  const { store, gh, syncer } = mk();
  let s = apply(null, ev('UserPromptSubmit', { prompt: 'hi' }), T0);
  s = apply(s, ev('Notification', { notification_type: 'permission_prompt', message: 'm' }), T0 + 1000);
  store.put(s); syncer.markDirty(s.id); await syncer.flush();
  gh.calls.length = 0;

  // Same state, same minute → nothing.
  syncer.markDirty(s.id); await syncer.flush();
  assert.deepEqual(gh.calls, []);

  // Five minutes later → only Waiting (min) changes; no REST write.
  const realNow = Date.now; Date.now = () => T0 + 6 * 60000;
  try { syncer.markDirty(s.id); await syncer.flush(); } finally { Date.now = realNow; }
  assert.equal(gh.calls.length, 1);
  assert.equal(gh.calls[0][0], 'setFields');
  assert.deepEqual(gh.calls[0][2], ['F_WAIT']);
});

test('SessionEnd closes the issue and archives the item once', async () => {
  const { store, gh, syncer } = mk();
  let s = apply(null, ev('UserPromptSubmit', { prompt: 'hi' }), T0);
  store.put(s); syncer.markDirty(s.id); await syncer.flush();
  gh.calls.length = 0;
  s = apply(store.get(s.id), ev('SessionEnd', { reason: 'other' }), T0 + 5000);
  store.put(s); syncer.markDirty(s.id); await syncer.flush();
  assert.deepEqual(gh.calls.map(c => c[0]), ['updateIssue', 'archive']);
  assert.ok(gh.calls[0][2].includes('state'));
  syncer.markDirty(s.id); await syncer.flush();
  assert.equal(gh.calls.length, 2, 'closed session does not resync');
});
