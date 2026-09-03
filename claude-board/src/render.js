import { STATUS_META } from './machine.js';
import { projectHex } from './color.js';

const clip = (s, n) => {
  if (!s) return '';
  const one = String(s).replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
};

export function statusLabelName(status) {
  return 'status:' + status.replace('_', '-');
}

export function title(s) {
  const meta = STATUS_META[s.status] || STATUS_META.working;
  const repo = s.repo ? `[${s.repo}] ` : '';
  const task = clip(s.currentPrompt, 70) || '(no prompt yet)';
  const branch = s.branch ? ` · ${s.branch}` : '';
  return `${meta.emoji} ${repo}${task}${branch}`.slice(0, 240);
}

/** Label names that should be on the issue right now. */
export function labels(s) {
  const out = [statusLabelName(s.status)];
  if (s.repo) out.push(`repo:${slug(s.repo)}`);
  out.push(`surface:${slug(s.surface || 'local')}`);
  if (s.permissionMode) out.push(`mode:${slug(s.permissionMode)}`);
  if (s.model) out.push(`model:${slug(shortModel(s.model))}`);
  return out;
}

function slug(x) { return String(x).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 40); }
function shortModel(m) {
  const s = String(m).toLowerCase();
  for (const k of ['opus', 'sonnet', 'haiku', 'fable', 'mythos']) if (s.includes(k)) return k;
  return s.slice(0, 20);
}

/** Definition (color, description) for any label the daemon may create. */
export function labelDef(name) {
  const [kind, ...rest] = name.split(':');
  const val = rest.join(':');
  if (kind === 'status') {
    const key = val.replace('-', '_');
    const meta = STATUS_META[key];
    return { name, color: meta ? meta.hex : '6B7280', description: meta ? `Session is ${meta.label.toLowerCase()}` : '' };
  }
  if (kind === 'repo') return { name, color: projectHex(val), description: `Repository: ${val}` };
  const palette = { surface: '4B5563', mode: '7C3AED', model: '0F766E' };
  const desc = { surface: 'Where the session runs', mode: 'Permission mode', model: 'Model' };
  return { name, color: palette[kind] || '6B7280', description: desc[kind] || '' };
}

const fmtTime = (ms) => ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + 'Z' : '—';
const mins = (a, b) => Math.max(0, Math.round((b - a) / 60000));

function mermaidSafe(s, n = 40) {
  return clip(s, n).replace(/[:#;`"<>{}\[\]|]/g, ' ').replace(/\s+/g, ' ').trim() || '…';
}

export function mermaidTimeline(s) {
  const turns = s.turns.slice(-8);
  if (!turns.length) return '';
  const lines = ['timeline', '    title Session turns'];
  turns.forEach((t, i) => {
    const n = s.turnCount - turns.length + i + 1;
    const when = new Date(t.at).toISOString().slice(11, 16);
    lines.push(`    section Turn ${n}`);
    lines.push(`        ${when} : ${mermaidSafe(t.prompt, 48)}`);
    if (t.endedAt) lines.push(`        ${new Date(t.endedAt).toISOString().slice(11, 16)} : ${mermaidSafe(t.lastMessage || 'done', 48)}`);
  });
  return '```mermaid\n' + lines.join('\n') + '\n```';
}

export function body(s, { now = Date.now(), issueRepo = '' } = {}) {
  const meta = STATUS_META[s.status] || STATUS_META.working;
  const out = [];
  out.push(`<!-- claude-board:session=${s.id} -->`);
  const waiting = s.status === 'needs_you' && s.blockedSince ? ` · waiting since **${fmtTime(s.blockedSince)}**` : '';
  out.push(`> **${meta.emoji} ${meta.label}**${waiting} · ${s.surface} · last event ${fmtTime(s.lastEventAt)}`);
  out.push('');
  out.push('## Resume');
  if (s.surface === 'cloud') {
    out.push('Cloud session — open it at <https://claude.ai/code>, or pull it into a terminal:');
    out.push('```bash');
    out.push(`claude --teleport ${s.id}`);
    out.push('```');
  } else {
    out.push('```bash');
    out.push(`claude --resume ${s.id}`);
    out.push('```');
  }
  if (s.cwd) out.push(`\`cd ${s.cwd}\``);
  out.push('');
  if (s.thumbnailUrl) { out.push(`![Latest screenshot](${s.thumbnailUrl})`); out.push(''); }
  out.push('## Current task');
  out.push(s.currentPrompt ? quote(clip(s.currentPrompt, 1500)) : '_No prompt received yet._');
  out.push('');
  out.push('## Last message from Claude');
  out.push(s.lastAssistantMessage ? clipBlock(s.lastAssistantMessage, 2500) : '_Nothing yet._');
  out.push('');
  if (s.status === 'needs_you') {
    const n = [...s.notifications].reverse().find(x => x.message);
    out.push('## Waiting on you');
    out.push(n ? `**${n.type}** — ${clip(n.message, 400)}` : '_Permission or input requested._');
    out.push('');
  }
  if (s.lastError) {
    out.push('## Last error');
    out.push(`**${s.lastError.type}** at ${fmtTime(s.lastError.at)}${s.lastError.message ? ' — ' + clip(s.lastError.message, 400) : ''}`);
    out.push('');
  }
  const files = Object.entries(s.files);
  if (files.length) {
    out.push(`## Files touched (${files.length})`);
    for (const [p, f] of files.slice(0, 40)) out.push(`- \`${p}\` +${f.adds} −${f.dels}${f.ops > 1 ? ` · ${f.ops} edits` : ''}`);
    if (files.length > 40) out.push(`- …and ${files.length - 40} more`);
    out.push('');
  }
  if (s.tasks.length) {
    const done = s.tasks.filter(t => t.done).length;
    out.push(`## Tasks (${done}/${s.tasks.length})`);
    for (const t of s.tasks) out.push(`- [${t.done ? 'x' : ' '}] ${clip(t.description, 120) || t.id}`);
    out.push('');
  }
  if (s.subagents.length) {
    out.push(`## Subagents (${s.subagents.filter(a => !a.endedAt).length} running)`);
    for (const a of s.subagents.slice(-20)) out.push(`- ${a.endedAt ? '✓' : '⋯'} ${a.type}${a.endedAt ? ` (${mins(a.startedAt, a.endedAt)} min)` : ''}`);
    out.push('');
  }
  const tl = mermaidTimeline(s);
  if (tl) { out.push('## Timeline'); out.push(tl); out.push(''); }
  out.push('<details><summary>Session details</summary>');
  out.push('');
  out.push(`- Session: \`${s.id}\``);
  out.push(`- Started: ${fmtTime(s.createdAt)} · turns: ${s.turnCount}`);
  if (s.cwd) out.push(`- cwd: \`${s.cwd}\``);
  if (s.branch) out.push(`- Branch: \`${s.branch}\``);
  if (s.model) out.push(`- Model: ${s.model}`);
  if (s.permissionMode) out.push(`- Permission mode: ${s.permissionMode}`);
  if (s.endReason) out.push(`- Ended: ${s.endReason}`);
  out.push('');
  out.push('</details>');
  out.push('');
  out.push('_Maintained by claude-board; edits to this body are overwritten on the next sync. Leave notes as comments — they reach the agent on its next prompt._');
  return out.join('\n');
}

function quote(t) { return t.split('\n').map(l => '> ' + l).join('\n'); }
function clipBlock(t, n) {
  const s = String(t).trim();
  return s.length > n ? s.slice(0, n) + '\n\n_…truncated_' : s;
}
