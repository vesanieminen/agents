import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

/**
 * Configuration precedence: env var > ~/.claude-board/config.json > default.
 * Every key here is documented in README.md; keep the two in step.
 */
export function loadConfig(env = process.env) {
  const dataDir = env.CLAUDE_BOARD_DATA_DIR || path.join(HOME, '.claude-board');
  const file = readJson(path.join(dataDir, 'config.json'));
  const pick = (envKey, fileKey, def) =>
    env[envKey] !== undefined && env[envKey] !== '' ? env[envKey] : (file[fileKey] ?? def);

  const cfg = {
    dataDir,
    token: pick('CLAUDE_BOARD_GITHUB_TOKEN', 'token', env.GITHUB_TOKEN || ''),
    repo: pick('CLAUDE_BOARD_REPO', 'repo', ''),              // owner/name; default resolved from viewer at setup
    projectTitle: pick('CLAUDE_BOARD_PROJECT_TITLE', 'projectTitle', 'Claude sessions'),
    port: Number(pick('CLAUDE_BOARD_PORT', 'port', 7777)),
    host: pick('CLAUDE_BOARD_HOST', 'host', '127.0.0.1'),
    syncMs: Number(pick('CLAUDE_BOARD_SYNC_MS', 'syncMs', 3000)),
    staleMin: Number(pick('CLAUDE_BOARD_STALE_MIN', 'staleMin', 10)),
    bearer: pick('CLAUDE_BOARD_TOKEN', 'bearer', ''),          // required for non-loopback callers when set
    dryRun: /^(1|true|yes)$/i.test(String(pick('CLAUDE_BOARD_DRY_RUN', 'dryRun', ''))),
    needsYou: String(pick('CLAUDE_BOARD_NEEDS_YOU', 'needsYou',
      'permission_prompt,agent_needs_input,elicitation_dialog,elicitation_url_dialog')).split(',').map(s => s.trim()).filter(Boolean),
    apiBase: pick('CLAUDE_BOARD_API_BASE', 'apiBase', 'https://api.github.com'),
  };
  return cfg;
}

export function saveConfig(cfg, patch) {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const file = path.join(cfg.dataDir, 'config.json');
  const current = readJson(file);
  const next = { ...current, ...patch };
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  return next;
}
