/**
 * Pure session state machine. `apply(session, event, now, opts)` returns a new
 * session record; nothing here touches the network or disk.
 *
 * Columns:  working · needs_you · errored · done · stale · closed
 */

export const STATUSES = ['working', 'needs_you', 'errored', 'done', 'stale', 'closed'];

export const STATUS_META = {
  working:   { label: 'Working',   emoji: '🔵', color: 'BLUE',   hex: '2A63C7' },
  needs_you: { label: 'Needs you', emoji: '🔴', color: 'RED',    hex: 'B4650B' },
  errored:   { label: 'Errored',   emoji: '🟠', color: 'ORANGE', hex: 'B23A2E' },
  done:      { label: 'Done',      emoji: '🟢', color: 'GREEN',  hex: '3F7A52' },
  stale:     { label: 'Stale',     emoji: '🟣', color: 'PURPLE', hex: '6E5BB0' },
  closed:    { label: 'Closed',    emoji: '⚫', color: 'GRAY',   hex: '6B7280' },
};

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function newSession(id, now) {
  return {
    id,
    createdAt: now,
    updatedAt: now,
    lastEventAt: now,
    status: 'working',
    blockedSince: null,
    idle: false,
    cwd: null,
    repo: null,
    branch: null,
    surface: 'local',
    permissionMode: null,
    model: null,
    turnCount: 0,
    currentPrompt: null,
    currentPromptAt: null,
    lastAssistantMessage: null,
    lastError: null,
    endReason: null,
    turns: [],          // {prompt, at, endedAt, lastMessage}
    files: {},          // path -> {adds, dels, ops}
    subagents: [],      // {id, type, startedAt, endedAt}
    tasks: [],          // {id, description, done}
    notifications: [],  // {type, message, at}
    issue: null,        // {number, url, nodeId, itemId}
    lastSeenCommentAt: null,
  };
}

function repoNameFromCwd(cwd) {
  if (!cwd) return null;
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || null;
}

function trimTail(arr, max) {
  return arr.length > max ? arr.slice(arr.length - max) : arr;
}

/**
 * @param {object} s      session (may be null for first event)
 * @param {object} ev     hook JSON input, plus optional ev.__surface
 * @param {number} now    ms epoch
 * @param {object} opts   { needsYou: string[] }
 */
export function apply(s, ev, now, opts = {}) {
  const needsYou = new Set(opts.needsYou || ['permission_prompt', 'agent_needs_input', 'elicitation_dialog', 'elicitation_url_dialog']);
  const cur = s ? structuredClone(s) : newSession(ev.session_id, now);

  cur.updatedAt = now;
  cur.lastEventAt = now;
  if (ev.cwd) { cur.cwd = ev.cwd; cur.repo = cur.repo || repoNameFromCwd(ev.cwd); }
  if (ev.permission_mode) cur.permissionMode = ev.permission_mode;
  if (ev.model) cur.model = ev.model;
  if (ev.__surface) cur.surface = ev.__surface;
  if (ev.__branch) cur.branch = ev.__branch;
  if (ev.__repo) cur.repo = ev.__repo;

  // A stale session that emits anything is alive again.
  if (cur.status === 'stale') cur.status = 'working';

  switch (ev.hook_event_name) {
    case 'SessionStart':
      if (cur.status === 'closed') cur.status = 'working';
      break;

    case 'UserPromptSubmit':
      cur.status = 'working';
      cur.blockedSince = null;
      cur.idle = false;
      cur.turnCount += 1;
      cur.currentPrompt = ev.prompt ?? null;
      cur.currentPromptAt = now;
      cur.turns = trimTail([...cur.turns, { prompt: ev.prompt ?? '', at: now, endedAt: null, lastMessage: null }], 50);
      break;

    case 'PostToolUse': {
      if (EDIT_TOOLS.has(ev.tool_name)) {
        const fp = ev.tool_input?.file_path || ev.tool_input?.notebook_path;
        if (fp) {
          const rel = cur.cwd && fp.startsWith(cur.cwd) ? fp.slice(cur.cwd.length).replace(/^[\\/]/, '') : fp;
          const f = cur.files[rel] || { adds: 0, dels: 0, ops: 0 };
          const gd = ev.tool_response?.gitDiff;
          f.adds += Number(gd?.additions || 0);
          f.dels += Number(gd?.deletions || 0);
          f.ops += 1;
          cur.files[rel] = f;
        }
      }
      break;
    }

    case 'Notification': {
      const type = ev.notification_type || ev.matcher || 'unknown';
      cur.notifications = trimTail([...cur.notifications, { type, message: ev.message ?? '', at: now }], 30);
      if (needsYou.has(type)) {
        cur.status = 'needs_you';
        if (!cur.blockedSince) cur.blockedSince = now;
      } else if (type === 'idle_prompt') {
        cur.idle = true;
      } else if (type === 'agent_completed') {
        cur.status = 'done';
        cur.blockedSince = null;
      }
      break;
    }

    case 'Stop':
      cur.status = 'done';
      cur.blockedSince = null;
      cur.lastAssistantMessage = ev.last_assistant_message ?? cur.lastAssistantMessage;
      if (cur.turns.length) {
        const t = cur.turns[cur.turns.length - 1];
        t.endedAt = now;
        t.lastMessage = ev.last_assistant_message ?? null;
      }
      break;

    case 'StopFailure':
      cur.status = 'errored';
      cur.lastError = { type: ev.error_type || ev.matcher || 'unknown', message: ev.error || ev.message || '', at: now };
      break;

    case 'SubagentStart':
      cur.subagents = trimTail([...cur.subagents, { id: ev.agent_id || null, type: ev.agent_type || 'agent', startedAt: now, endedAt: null }], 40);
      break;

    case 'SubagentStop': {
      const a = [...cur.subagents].reverse().find(x => (ev.agent_id && x.id === ev.agent_id) || (!ev.agent_id && !x.endedAt && x.type === (ev.agent_type || 'agent')));
      if (a) a.endedAt = now;
      break;
    }

    case 'TaskCreated':
      cur.tasks = trimTail([...cur.tasks, { id: ev.task_id || ev.id || String(cur.tasks.length + 1), description: ev.description || ev.subject || ev.task?.subject || '', done: false }], 60);
      break;

    case 'TaskCompleted': {
      const id = ev.task_id || ev.id || ev.task?.id;
      const t = cur.tasks.find(x => x.id === id) || cur.tasks.find(x => !x.done);
      if (t) t.done = true;
      break;
    }

    case 'SessionEnd':
      cur.status = 'closed';
      cur.blockedSince = null;
      cur.endReason = ev.reason || 'other';
      break;

    default:
      break;
  }
  return cur;
}

/** Mark working sessions with no events for `staleMs` as stale. Returns changed ids. */
export function sweepStale(sessions, now, staleMs) {
  const changed = [];
  for (const s of Object.values(sessions)) {
    if (s.status === 'working' && now - s.lastEventAt > staleMs) {
      s.status = 'stale';
      s.updatedAt = now;
      changed.push(s.id);
    }
  }
  return changed;
}

/** Inbox ordering: needs_you first by longest blocked, then errored, stale, working, done. */
export function sortForInbox(list, now = Date.now()) {
  const rank = { needs_you: 0, errored: 1, stale: 2, working: 3, done: 4, closed: 5 };
  return [...list].sort((a, b) => {
    const r = rank[a.status] - rank[b.status];
    if (r) return r;
    if (a.status === 'needs_you') return (a.blockedSince ?? now) - (b.blockedSince ?? now);
    return b.lastEventAt - a.lastEventAt;
  });
}
