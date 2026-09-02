import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const EVENTS = [
  { event: 'SessionStart' },
  { event: 'UserPromptSubmit' },
  { event: 'PostToolUse', matcher: 'Edit|Write|MultiEdit|NotebookEdit' },
  { event: 'Notification' },
  { event: 'Stop' },
  { event: 'StopFailure' },
  { event: 'SubagentStart' },
  { event: 'SubagentStop' },
  { event: 'TaskCreated' },
  { event: 'TaskCompleted' },
  { event: 'SessionEnd', timeout: 2 },
];

export function settingsPath(env = process.env) {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(dir, 'settings.json');
}

/** The hook entry we install. Recognizable by the X-Claude-Board header. */
export function hookEntry({ url, surface = 'local', bearerEnv = null, timeout = 5 }) {
  const headers = { 'X-Claude-Board': '1', 'X-Claude-Board-Surface': surface };
  const entry = { type: 'http', url, timeout, headers };
  if (bearerEnv) { headers['Authorization'] = `Bearer $${bearerEnv}`; entry.allowedEnvVars = [bearerEnv]; }
  return entry;
}

export function renderHooks(opts) {
  const hooks = {};
  for (const e of EVENTS) {
    const group = { hooks: [hookEntry({ ...opts, timeout: e.timeout ?? 5 })] };
    if (e.matcher) group.matcher = e.matcher;
    hooks[e.event] = [group];
  }
  return hooks;
}

const isOurs = (h) => h?.type === 'http' && h?.headers?.['X-Claude-Board'] === '1';

/** Merge our hooks into a settings object, replacing any earlier claude-board entries. Pure. */
export function mergeHooks(settings, opts) {
  const out = structuredClone(settings || {});
  out.hooks = out.hooks || {};
  // strip previous installs
  for (const [ev, groups] of Object.entries(out.hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups.map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !isOurs(h)) })).filter(g => g.hooks.length);
    if (kept.length) out.hooks[ev] = kept; else delete out.hooks[ev];
  }
  for (const [ev, groups] of Object.entries(renderHooks(opts))) {
    out.hooks[ev] = [...(out.hooks[ev] || []), ...groups];
  }
  return out;
}

export function removeHooks(settings) {
  const out = structuredClone(settings || {});
  if (!out.hooks) return out;
  for (const [ev, groups] of Object.entries(out.hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups.map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !isOurs(h)) })).filter(g => g.hooks.length);
    if (kept.length) out.hooks[ev] = kept; else delete out.hooks[ev];
  }
  if (!Object.keys(out.hooks).length) delete out.hooks;
  return out;
}

export function installToFile(file, opts) {
  let settings = {};
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    settings = raw.trim() ? JSON.parse(raw) : {};
    fs.copyFileSync(file, file + '.claude-board.bak');
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const next = mergeHooks(settings, opts);
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  return next;
}

export function uninstallFromFile(file) {
  if (!fs.existsSync(file)) return null;
  const settings = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
  fs.copyFileSync(file, file + '.claude-board.bak');
  const next = removeHooks(settings);
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  return next;
}
