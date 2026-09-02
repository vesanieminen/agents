import fs from 'node:fs';
import path from 'node:path';

/** JSON-file persistence for the session map. Writes are coalesced. */
export class Store {
  constructor(dataDir, { log = () => {} } = {}) {
    this.file = path.join(dataDir, 'sessions.json');
    this.log = log;
    this.sessions = {};
    this._timer = null;
    fs.mkdirSync(dataDir, { recursive: true });
    try { this.sessions = JSON.parse(fs.readFileSync(this.file, 'utf8')).sessions || {}; }
    catch { this.sessions = {}; }
  }
  get(id) { return this.sessions[id] || null; }
  put(s) { this.sessions[s.id] = s; this.schedule(); return s; }
  list() { return Object.values(this.sessions); }
  remove(id) { delete this.sessions[id]; this.schedule(); }
  schedule() {
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this.flush(); }, 500);
  }
  flush() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, sessions: this.sessions }));
    fs.renameSync(tmp, this.file);
  }
  /** Drop closed sessions older than `ms`. */
  prune(now, ms) {
    let n = 0;
    for (const s of this.list()) if (s.status === 'closed' && now - s.updatedAt > ms) { delete this.sessions[s.id]; n++; }
    if (n) this.schedule();
    return n;
  }
}
