import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { apply, sweepStale } from './machine.js';
import { gitInfo } from './git.js';
import { dashboardHtml } from './dashboard.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const IMAGE_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const THUMB_CONVENTION = /[\\/]\.claude-board[\\/]thumbnail\.(png|jpe?g|webp)$/i;
const MAX_THUMB = 3 * 1024 * 1024;

/**
 * The daemon's HTTP surface:
 *   POST /event         hook receiver (Claude Code http hooks)
 *   POST /sessions/:id/thumbnail   image body (png/jpeg/webp) → card thumbnail
 *   GET  /thumbs/:file  thumbnails
 *   GET  /              dashboard
 *   GET  /events        SSE stream of full state
 *   GET  /api/sessions  JSON
 *   GET  /health
 */
export function createServer({ cfg, store, syncer, log = () => {} }) {
  const clients = new Set();
  const thumbDir = path.join(cfg.dataDir, 'thumbs');
  fs.mkdirSync(thumbDir, { recursive: true });

  /** Store an image for a session and point the card at it. */
  function setThumbnail(s, buf, ext) {
    const file = `${s.id}.${ext}`;
    fs.writeFileSync(path.join(thumbDir, file), buf);
    s.thumbnail = file; s.thumbnailAt = Date.now();
    store.put(s);
    syncer.markDirty(s.id);
  }

  const snapshot = () => ({
    sessions: store.list(),
    repo: cfg.repo,
    projectUrl: syncer.project?.url || '',
    dryRun: cfg.dryRun,
  });
  const broadcast = () => {
    const data = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of clients) res.write(data);
  };
  syncer.onSynced = () => broadcast();

  const authorized = (req) => {
    const ip = req.socket.remoteAddress || '';
    if (LOOPBACK.has(ip)) return true;
    if (!cfg.bearer) return false;
    return req.headers.authorization === `Bearer ${cfg.bearer}`;
  };

  async function handleEvent(req, res, raw) {
    let ev;
    try { ev = JSON.parse(raw); } catch { return reply(res, 400, { error: 'invalid JSON' }); }
    if (!ev?.session_id || !ev?.hook_event_name) return reply(res, 400, { error: 'session_id and hook_event_name required' });

    const surface = String(req.headers['x-claude-board-surface'] || 'local').toLowerCase();
    ev.__surface = surface === 'cloud' ? 'cloud' : 'local';
    if (ev.__surface === 'local' && ev.cwd) {
      const g = await gitInfo(ev.cwd);
      if (g.branch) ev.__branch = g.branch;
      if (g.repo) ev.__repo = g.repo;
    }

    const now = Date.now();
    const prev = store.get(ev.session_id);
    const next = apply(prev, ev, now, { needsYou: cfg.needsYou });
    store.put(next);

    // Convention: a session that writes .claude-board/thumbnail.png in its cwd sets its own card art.
    if (ev.hook_event_name === 'PostToolUse' && ev.__surface === 'local') {
      const fp = ev.tool_input?.file_path;
      const m = fp && fp.match(THUMB_CONVENTION);
      if (m && fs.existsSync(fp)) {
        try {
          const st = fs.statSync(fp);
          if (st.size <= MAX_THUMB) { setThumbnail(next, fs.readFileSync(fp), m[1].toLowerCase().replace('jpeg', 'jpg')); log(`thumbnail: ${next.id.slice(0, 8)} from ${fp}`); }
        } catch (e) { log('thumbnail: ' + e.message); }
      }
    }
    syncer.markDirty(next.id);
    broadcast();
    log(`event: ${ev.hook_event_name}${ev.notification_type ? '/' + ev.notification_type : ''} ${next.id.slice(0, 8)} → ${next.status}`);

    // Board comments reach the agent on its next prompt.
    if (ev.hook_event_name === 'UserPromptSubmit') {
      const ctx = await syncer.newComments(next).catch(() => null);
      if (ctx) return reply(res, 200, { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `Notes left on your claude-board card:\n\n${ctx}` } });
    }
    return reply(res, 200, {});
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/event') {
      if (!authorized(req)) return reply(res, 403, { error: 'unauthorized' });
      let raw = '';
      req.on('data', c => { raw += c; if (raw.length > 5e6) req.destroy(); });
      req.on('end', () => handleEvent(req, res, raw).catch(e => { log('event error: ' + e.message); reply(res, 500, { error: e.message }); }));
      return;
    }
    const thumbPost = req.method === 'POST' && url.pathname.match(/^\/sessions\/([^/]+)\/thumbnail$/);
    if (thumbPost) {
      if (!authorized(req)) return reply(res, 403, { error: 'unauthorized' });
      const ext = IMAGE_TYPES[(req.headers['content-type'] || '').split(';')[0].trim()];
      if (!ext) return reply(res, 415, { error: 'send image/png, image/jpeg or image/webp' });
      const s = store.get(decodeURIComponent(thumbPost[1]));
      if (!s) return reply(res, 404, { error: 'unknown session' });
      const chunks = []; let size = 0;
      req.on('data', c => { size += c.length; if (size > MAX_THUMB) { req.destroy(); return; } chunks.push(c); });
      req.on('end', () => { setThumbnail(s, Buffer.concat(chunks), ext); broadcast(); reply(res, 200, { thumbnail: `/thumbs/${s.thumbnail}` }); });
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/thumbs/')) {
      const file = path.basename(url.pathname);
      const type = IMAGE_EXT[file.split('.').pop().toLowerCase()];
      const full = path.join(thumbDir, file);
      if (!type || !fs.existsSync(full)) return reply(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      return fs.createReadStream(full).pipe(res);
    }
    if (req.method === 'GET' && url.pathname === '/health') return reply(res, 200, { ok: true, sessions: store.list().length, dryRun: cfg.dryRun });
    if (req.method === 'GET' && url.pathname === '/api/sessions') return reply(res, 200, snapshot());
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(dashboardHtml());
    }
    reply(res, 404, { error: 'not found' });
  });

  // Stale sweep once a minute; the Waiting (min) field is refreshed every fifth
  // sweep so a long Needs-you queue costs one small mutation per session per 5 min.
  let sweeps = 0;
  const sweep = setInterval(() => {
    const now = Date.now();
    sweeps++;
    const changed = sweepStale(store.sessions, now, cfg.staleMin * 60000);
    for (const id of changed) { store.put(store.get(id)); syncer.markDirty(id); log(`stale: ${id.slice(0, 8)}`); }
    if (sweeps % 5 === 0) for (const s of store.list()) if (s.status === 'needs_you') syncer.markDirty(s.id);
    store.prune(now, 7 * 24 * 3600 * 1000);
    if (changed.length) broadcast();
  }, 60000);
  sweep.unref?.();

  server.on('close', () => clearInterval(sweep));
  return server;
}

function reply(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}
