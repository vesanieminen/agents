#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig } from '../src/config.js';
import { GitHub } from '../src/github.js';
import { Store } from '../src/store.js';
import { Syncer } from '../src/sync.js';
import { createServer } from '../src/server.js';
import { findProject, createProject, ensureFields, readProjectCache, writeProjectCache, STATUS_OPTIONS, CUSTOM_FIELDS } from '../src/project.js';
import { settingsPath, installToFile, uninstallFromFile, renderHooks } from '../src/hooks.js';
import { labelDef } from '../src/render.js';
import { STATUS_META, sortForInbox } from '../src/machine.js';

const log = (m) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const args = process.argv.slice(2);
const cmd = args[0] || 'serve';
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] ?? true) : undefined; };
const has = (name) => args.includes(name);

const HELP = `claude-board — live Kanban board of your Claude Code sessions

Usage:
  claude-board setup                 Create the issues repo, project board, fields and labels (idempotent)
  claude-board install-hooks         Add http hooks to ~/.claude/settings.json (backs it up first)
  claude-board install-hooks --cloud https://your-tunnel.example --print
                                     Print a .claude/settings.json snippet for repos your cloud sessions clone
  claude-board uninstall-hooks       Remove claude-board hooks from ~/.claude/settings.json
  claude-board serve                 Run the daemon (default). Dashboard at http://127.0.0.1:7777
  claude-board status                Print live sessions from the daemon's store
  claude-board doctor                Check token, repo, project cache and hook installation

Environment (or ~/.claude-board/config.json):
  CLAUDE_BOARD_GITHUB_TOKEN  classic PAT with 'project' and 'repo' scopes (falls back to GITHUB_TOKEN)
  CLAUDE_BOARD_REPO          owner/name for session issues        (default: <you>/claude-board)
  CLAUDE_BOARD_PROJECT_TITLE project board title                  (default: "Claude sessions")
  CLAUDE_BOARD_PORT          daemon port                          (default: 7777)
  CLAUDE_BOARD_HOST          bind address                         (default: 127.0.0.1; 0.0.0.0 for tunnels)
  CLAUDE_BOARD_TOKEN         bearer required from non-loopback callers (cloud sessions)
  CLAUDE_BOARD_SYNC_MS       debounce for GitHub writes           (default: 3000)
  CLAUDE_BOARD_STALE_MIN     minutes of silence before Stale      (default: 10)
  CLAUDE_BOARD_NEEDS_YOU     notification types that mean "Needs you"
  CLAUDE_BOARD_DRY_RUN=1     never write to GitHub; log instead
`;

async function main() {
  const cfg = loadConfig();
  switch (cmd) {
    case 'help': case '--help': case '-h': console.log(HELP); return;
    case 'setup': return setup(cfg);
    case 'install-hooks': return installHooks(cfg);
    case 'uninstall-hooks': {
      const f = flag('--settings') || settingsPath();
      const r = uninstallFromFile(f);
      console.log(r ? `Removed claude-board hooks from ${f}` : `No settings file at ${f}`);
      return;
    }
    case 'serve': return serve(cfg);
    case 'status': return status(cfg);
    case 'doctor': return doctor(cfg);
    default: console.error(`Unknown command: ${cmd}\n`); console.log(HELP); process.exit(2);
  }
}

async function resolveRepo(cfg, gh) {
  if (cfg.repo) return cfg.repo;
  const v = await gh.viewer();
  return `${v.login}/claude-board`;
}

async function setup(cfg) {
  const gh = new GitHub({ token: cfg.token, apiBase: cfg.apiBase, log });
  const { viewer, project: existing } = await findProject(gh, cfg.projectTitle);
  log(`authenticated as ${viewer.login}`);

  const repo = cfg.repo || `${viewer.login}/claude-board`;
  const [owner, name] = repo.split('/');
  const r = await gh.ensureRepo(owner, name, { isPrivate: true, description: 'Claude Code session board (maintained by claude-board)' });
  log(`issues repo: ${r.html_url}${r.private ? ' (private)' : ''}`);

  const project = existing || await createProject(gh, viewer.id, cfg.projectTitle);
  log(`${existing ? 'found' : 'created'} project #${project.number}: ${project.url}`);
  const fields = await ensureFields(gh, project, { log });

  const names = [
    ...Object.keys(STATUS_META).map(k => 'status:' + k.replace('_', '-')),
    'surface:local', 'surface:cloud',
    ...['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'].map(m => 'mode:' + m.toLowerCase()),
  ];
  let created = 0;
  for (const n of names) if (await gh.ensureLabel(repo, labelDef(n))) created++;
  log(`labels: ${created} created, ${names.length - created} already present`);

  writeProjectCache(cfg.dataDir, fields);
  saveConfig(cfg, { repo, projectTitle: cfg.projectTitle });

  console.log(`
Setup complete.
  Issues repo : ${r.html_url}
  Project     : ${fields.url}
  Status      : ${STATUS_OPTIONS.map(o => o.name).join(' · ')}
  Fields      : ${CUSTOM_FIELDS.map(f => f.name).join(' · ')}

Next:
  1. claude-board install-hooks
  2. claude-board serve            (leave it running; dashboard at http://127.0.0.1:${cfg.port})
  3. open ${fields.url} and switch the view to Board, grouped by Status
`);
}

async function installHooks(cfg) {
  const cloud = flag('--cloud');
  if (cloud && typeof cloud === 'string') {
    const url = cloud.replace(/\/$/, '') + '/event';
    const snippet = { hooks: renderHooks({ url, surface: 'cloud', bearerEnv: 'CLAUDE_BOARD_TOKEN' }) };
    console.log(JSON.stringify(snippet, null, 2));
    console.error(`
Commit that as .claude/settings.json in each repository your cloud sessions clone, and set
CLAUDE_BOARD_TOKEN in the cloud environment's variables to the same value the daemon runs with.
The daemon must be reachable at ${cloud} (a tunnel such as cloudflared/ngrok/tailscale funnel),
bound with CLAUDE_BOARD_HOST=0.0.0.0.`);
    return;
  }
  const url = `http://127.0.0.1:${cfg.port}/event`;
  const file = flag('--settings') || settingsPath();
  if (has('--print')) { console.log(JSON.stringify({ hooks: renderHooks({ url, surface: 'local' }) }, null, 2)); return; }
  installToFile(file, { url, surface: 'local' });
  console.log(`Installed claude-board hooks into ${file} (backup: ${file}.claude-board.bak)\nNew Claude Code sessions will report to ${url}. Sessions already running pick hooks up on their next start.`);
}

async function serve(cfg) {
  const store = new Store(cfg.dataDir, { log });
  let gh = null, project = null;
  if (!cfg.dryRun) {
    gh = new GitHub({ token: cfg.token, apiBase: cfg.apiBase, log });
    if (!cfg.repo) { cfg.repo = await resolveRepo(cfg, gh); saveConfig(cfg, { repo: cfg.repo }); }
    project = readProjectCache(cfg.dataDir);
    if (!project) log('no project cache — run `claude-board setup` to create the board. Issues will still be created.');
  } else {
    log('DRY RUN: nothing will be written to GitHub');
    cfg.repo = cfg.repo || 'dry/run';
  }
  const syncer = new Syncer({ gh, cfg, store, project, log });
  const server = createServer({ cfg, store, syncer, log });
  syncer.start();
  server.listen(cfg.port, cfg.host, () => {
    log(`claude-board listening on http://${cfg.host}:${cfg.port}  repo=${cfg.repo}  project=${project?.url || '(none)'}  sessions=${store.list().length}`);
  });
  const stop = () => { log('shutting down'); syncer.stop(); store.flush(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

async function status(cfg) {
  const store = new Store(cfg.dataDir, { log });
  const live = sortForInbox(store.list().filter(s => s.status !== 'closed'));
  if (!live.length) return console.log('No live sessions.');
  const now = Date.now();
  for (const s of live) {
    const m = STATUS_META[s.status];
    const wait = s.status === 'needs_you' && s.blockedSince ? ` waiting ${Math.round((now - s.blockedSince) / 60000)}m` : '';
    console.log(`${m.emoji} ${m.label.padEnd(9)} ${(s.repo || '?').padEnd(18)} ${String(s.currentPrompt || '').replace(/\s+/g, ' ').slice(0, 60).padEnd(60)}${wait}  ${s.issue?.url || ''}`);
  }
}

async function doctor(cfg) {
  const out = (ok, msg) => console.log(`${ok ? '✓' : '✗'} ${msg}`);
  out(!!cfg.token, cfg.token ? 'token present' : 'no token: set CLAUDE_BOARD_GITHUB_TOKEN (classic PAT, scopes: project, repo)');
  if (cfg.token) {
    try {
      const res = await fetch(cfg.apiBase + '/user', { headers: { Authorization: `Bearer ${cfg.token}`, 'User-Agent': 'claude-board' } });
      const scopes = (res.headers.get('x-oauth-scopes') || '').split(',').map(s => s.trim()).filter(Boolean);
      const u = await res.json();
      out(res.ok, `token belongs to ${u.login || '?'}; scopes: ${scopes.join(', ') || '(none reported — fine-grained tokens report none, and cannot access user projects)'}`);
      out(scopes.includes('project'), scopes.includes('project') ? "'project' scope present" : "'project' scope missing — board writes will fail with FORBIDDEN");
      out(scopes.includes('repo') || scopes.includes('public_repo'), "'repo' scope " + (scopes.includes('repo') ? 'present' : 'missing — issue writes to a private repo will fail'));
    } catch (e) { out(false, 'token check failed: ' + e.message); }
  }
  out(!!cfg.repo, cfg.repo ? `issues repo: ${cfg.repo}` : 'no repo configured yet (setup sets it)');
  const pc = readProjectCache(cfg.dataDir);
  out(!!pc, pc ? `project cache: #${pc.number} ${pc.url}` : 'no project cache — run `claude-board setup`');
  const sp = settingsPath();
  let installed = false;
  try { installed = JSON.stringify(JSON.parse(fs.readFileSync(sp, 'utf8'))).includes('"X-Claude-Board"'); } catch {}
  out(installed, installed ? `hooks installed in ${sp}` : `hooks not installed — run \`claude-board install-hooks\` (${sp})`);
  try {
    const h = await fetch(`http://127.0.0.1:${cfg.port}/health`).then(r => r.json());
    out(true, `daemon running on :${cfg.port} (${h.sessions} sessions${h.dryRun ? ', DRY RUN' : ''})`);
  } catch { out(false, `daemon not running on :${cfg.port} — run \`claude-board serve\``); }
}

main().catch(e => { console.error('error:', e.message); if (process.env.DEBUG) console.error(e); process.exit(1); });
