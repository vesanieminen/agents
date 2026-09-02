/**
 * Minimal GitHub client: REST + GraphQL over fetch, with retry on 429/5xx and
 * secondary rate limits. Node 20+ has fetch built in.
 */
export class GitHub {
  constructor({ token, apiBase = 'https://api.github.com', log = () => {} }) {
    if (!token) throw new Error('GitHub token missing. Set CLAUDE_BOARD_GITHUB_TOKEN (classic PAT with project + repo scopes).');
    this.token = token;
    this.apiBase = apiBase.replace(/\/$/, '');
    this.log = log;
  }

  headers(extra = {}) {
    return {
      'Authorization': `Bearer ${this.token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'claude-board',
      ...extra,
    };
  }

  async _fetch(url, init, attempt = 0) {
    const res = await fetch(url, init);
    if ((res.status === 429 || res.status === 403 && /rate limit/i.test(await peek(res))) || res.status >= 500) {
      if (attempt >= 3) return res;
      const ra = Number(res.headers.get('retry-after')) || Math.min(30, 2 ** attempt * 2);
      this.log(`github: ${res.status} on ${init.method || 'GET'} ${url} — retrying in ${ra}s`);
      await sleep(ra * 1000);
      return this._fetch(url, init, attempt + 1);
    }
    return res;
  }

  async rest(method, path, body) {
    const url = path.startsWith('http') ? path : this.apiBase + path;
    const res = await this._fetch(url, {
      method,
      headers: this.headers(body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`GitHub REST ${method} ${path} → ${res.status}: ${json?.message || text.slice(0, 200)}`);
      err.status = res.status; err.body = json;
      throw err;
    }
    return json;
  }

  async graphql(query, variables = {}) {
    const res = await this._fetch(this.apiBase + '/graphql', {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`GitHub GraphQL → ${res.status}: ${json?.message || JSON.stringify(json).slice(0, 300)}`);
      err.status = res.status; throw err;
    }
    if (json.errors?.length) {
      const err = new Error('GitHub GraphQL: ' + json.errors.map(e => `${e.type || ''} ${e.message}`.trim()).join('; '));
      err.errors = json.errors; err.data = json.data; throw err;
    }
    return json.data;
  }

  // ---- convenience ----
  viewer() { return this.graphql('query { viewer { id login } }').then(d => d.viewer); }

  async ensureRepo(owner, name, { isPrivate = true, description = '' } = {}) {
    try { return await this.rest('GET', `/repos/${owner}/${name}`); }
    catch (e) { if (e.status !== 404) throw e; }
    this.log(`github: creating repository ${owner}/${name} (private=${isPrivate})`);
    return this.rest('POST', '/user/repos', { name, private: isPrivate, description, auto_init: true, has_projects: false, has_wiki: false });
  }

  async ensureLabel(repo, def) {
    try { await this.rest('POST', `/repos/${repo}/labels`, def); return true; }
    catch (e) {
      if (e.status === 422) { // exists — keep color/description current
        await this.rest('PATCH', `/repos/${repo}/labels/${encodeURIComponent(def.name)}`, { color: def.color, description: def.description }).catch(() => {});
        return false;
      }
      throw e;
    }
  }

  createIssue(repo, { title, body, labels }) { return this.rest('POST', `/repos/${repo}/issues`, { title, body, labels }); }
  updateIssue(repo, number, patch) { return this.rest('PATCH', `/repos/${repo}/issues/${number}`, patch); }
  listComments(repo, number, sinceIso) {
    const q = sinceIso ? `?since=${encodeURIComponent(sinceIso)}&per_page=20` : '?per_page=20';
    return this.rest('GET', `/repos/${repo}/issues/${number}/comments${q}`);
  }
  async findIssueBySession(repo, sessionId) {
    const q = encodeURIComponent(`repo:${repo} is:issue "claude-board:session=${sessionId}" in:body`);
    const r = await this.rest('GET', `/search/issues?q=${q}&per_page=1`);
    return r?.items?.[0] || null;
  }
}

async function peek(res) { try { return await res.clone().text(); } catch { return ''; } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
