/**
 * Debounced GitHub sync. Sessions are marked dirty by the server; every
 * `syncMs` the dirty set is flushed: one REST issue write and one aliased
 * GraphQL mutation per session, and nothing at all when nothing changed.
 */
import crypto from 'node:crypto';
import { title, body, labels, labelDef } from './render.js';
import { addItem, archiveItem, setItemFields } from './project.js';

export class Syncer {
  constructor({ gh, cfg, store, project, log = () => {}, onSynced = () => {} }) {
    this.gh = gh; this.cfg = cfg; this.store = store; this.project = project; this.log = log; this.onSynced = onSynced;
    this.dirty = new Set();
    this.backoff = new Map();     // id -> nextTryAt
    this.hashes = new Map();      // id -> last synced hash
    this.knownLabels = new Set();
    this.timer = null;
    this.inFlight = false;
  }

  start() { this.timer = setInterval(() => this.flush().catch(e => this.log('sync: ' + e.message)), this.cfg.syncMs); this.timer.unref?.(); }
  stop() { clearInterval(this.timer); }
  markDirty(id) { this.dirty.add(id); }

  async flush() {
    if (this.inFlight || !this.dirty.size) return;
    this.inFlight = true;
    try {
      const now = Date.now();
      for (const id of [...this.dirty]) {
        if ((this.backoff.get(id) || 0) > now) continue;
        const s = this.store.get(id);
        this.dirty.delete(id);
        if (!s) continue;
        try {
          await this.syncOne(s, now);
          this.backoff.delete(id);
        } catch (e) {
          const prev = this.backoff.get(id + ':n') || 0;
          const wait = Math.min(300000, 5000 * 2 ** prev);
          this.backoff.set(id, now + wait); this.backoff.set(id + ':n', prev + 1);
          this.dirty.add(id);
          this.log(`sync: ${id.slice(0, 8)} failed (${e.message}); retry in ${Math.round(wait / 1000)}s`);
        }
      }
    } finally { this.inFlight = false; }
  }

  fieldValues(s, now) {
    const p = this.project; if (!p) return [];
    const vals = [];
    const optId = p.status.options[statusName(s.status)];
    if (optId && s.status !== 'closed') vals.push({ fieldId: p.status.id, value: { singleSelectOptionId: optId } });
    const c = p.custom;
    const push = (name, value) => { if (c[name]) vals.push({ fieldId: c[name], value }); };
    push('Waiting (min)', { number: s.status === 'needs_you' && s.blockedSince ? Math.round((now - s.blockedSince) / 60000) : 0 });
    push('Last activity', { text: new Date(s.lastEventAt).toISOString() });
    push('Turns', { number: s.turnCount });
    push('Files touched', { number: Object.keys(s.files).length });
    if (s.branch) push('Branch', { text: s.branch });
    push('Session', { text: s.id });
    return vals;
  }

  async ensureLabels(names) {
    for (const n of names) {
      if (this.knownLabels.has(n)) continue;
      await this.gh.ensureLabel(this.cfg.repo, labelDef(n));
      this.knownLabels.add(n);
    }
  }

  async syncOne(s, now) {
    const t = title(s), b = body(s, { now, issueRepo: this.cfg.repo }), l = labels(s);
    const fv = this.fieldValues(s, now);
    const hash = crypto.createHash('sha1').update(JSON.stringify([t, b, l, fv, s.status])).digest('hex');
    if (this.hashes.get(s.id) === hash) return;

    if (this.cfg.dryRun) {
      this.log(`dry-run: ${s.id.slice(0, 8)} → ${t} | ${l.join(' ')} | fields=${fv.length}${s.status === 'closed' ? ' | close+archive' : ''}`);
      if (!s.issue) { s.issue = { number: 0, url: '', nodeId: null, itemId: null, dry: true }; this.store.put(s); }
      this.hashes.set(s.id, hash); this.onSynced(s);
      return;
    }

    await this.ensureLabels(l);

    if (!s.issue) {
      // Recover from a lost map before creating a duplicate.
      const found = await this.gh.findIssueBySession(this.cfg.repo, s.id).catch(() => null);
      const issue = found || await this.gh.createIssue(this.cfg.repo, { title: t, body: b, labels: l });
      s.issue = { number: issue.number, url: issue.html_url, nodeId: issue.node_id, itemId: null };
      this.log(`sync: ${found ? 'recovered' : 'created'} issue #${issue.number} for ${s.id.slice(0, 8)}`);
      if (found) await this.gh.updateIssue(this.cfg.repo, issue.number, { title: t, body: b, labels: l, state: 'open' });
    } else {
      const patch = { title: t, body: b, labels: l };
      if (s.status === 'closed') { patch.state = 'closed'; patch.state_reason = 'completed'; }
      await this.gh.updateIssue(this.cfg.repo, s.issue.number, patch);
    }

    if (this.project && s.issue.nodeId) {
      if (!s.issue.itemId) s.issue.itemId = await addItem(this.gh, this.project.id, s.issue.nodeId);
      if (s.status === 'closed') {
        await archiveItem(this.gh, this.project.id, s.issue.itemId).catch(e => this.log('sync: archive failed: ' + e.message));
      } else {
        await setItemFields(this.gh, this.project.id, s.issue.itemId, fv);
      }
    }
    this.store.put(s);
    this.hashes.set(s.id, hash);
    this.onSynced(s);
  }

  /** Comments newer than the session's watermark, formatted for additionalContext. Fast-fails. */
  async newComments(s, budgetMs = 2000) {
    if (!s.issue?.number || this.cfg.dryRun) return null;
    const since = s.lastSeenCommentAt ? new Date(s.lastSeenCommentAt).toISOString() : new Date(s.createdAt).toISOString();
    const res = await Promise.race([
      this.gh.listComments(this.cfg.repo, s.issue.number, since).catch(() => null),
      new Promise(r => setTimeout(() => r(null), budgetMs)),
    ]);
    if (!res?.length) return null;
    const fresh = res.filter(c => !/claude-board/i.test(c.user?.login || '') && new Date(c.created_at).getTime() > (s.lastSeenCommentAt || 0));
    if (!fresh.length) return null;
    s.lastSeenCommentAt = Math.max(...fresh.map(c => new Date(c.created_at).getTime()));
    this.store.put(s);
    return fresh.map(c => `— ${c.user?.login || 'someone'} commented on your board card (${c.html_url}):\n${c.body}`).join('\n\n');
  }
}

function statusName(key) {
  return { working: 'Working', needs_you: 'Needs you', errored: 'Errored', done: 'Done', stale: 'Stale' }[key];
}
