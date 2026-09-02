/**
 * GitHub Projects v2 plumbing. Everything here is GraphQL, so it only runs
 * where GraphQL is reachable: the user's machine or a GitHub Actions runner.
 */
import fs from 'node:fs';
import path from 'node:path';
import { STATUS_META } from './machine.js';

/** Column options, in board order. `closed` is archived rather than a column. */
export const STATUS_OPTIONS = ['working', 'needs_you', 'errored', 'done', 'stale'].map(k => ({
  key: k, name: STATUS_META[k].label, color: STATUS_META[k].color, description: `Session is ${STATUS_META[k].label.toLowerCase()}`,
}));

/** Custom fields the daemon writes. TEXT for timestamps so table views sort them. */
export const CUSTOM_FIELDS = [
  { name: 'Waiting (min)', dataType: 'NUMBER' },
  { name: 'Last activity', dataType: 'TEXT' },
  { name: 'Turns', dataType: 'NUMBER' },
  { name: 'Files touched', dataType: 'NUMBER' },
  { name: 'Branch', dataType: 'TEXT' },
  { name: 'Session', dataType: 'TEXT' },
];

const FIELDS_FRAGMENT = `
  fields(first: 50) {
    nodes {
      ... on ProjectV2FieldCommon { id name dataType }
      ... on ProjectV2SingleSelectField { options { id name color } }
    }
  }`;

export async function findProject(gh, title) {
  const d = await gh.graphql(`query { viewer { id login projectsV2(first: 100) { nodes { id number title url closed } } } }`);
  const p = d.viewer.projectsV2.nodes.find(p => p.title === title && !p.closed);
  return { viewer: { id: d.viewer.id, login: d.viewer.login }, project: p || null };
}

export async function createProject(gh, ownerId, title) {
  const d = await gh.graphql(
    `mutation($owner: ID!, $title: String!) { createProjectV2(input: { ownerId: $owner, title: $title }) { projectV2 { id number title url } } }`,
    { owner: ownerId, title });
  return d.createProjectV2.projectV2;
}

export async function loadProject(gh, projectId) {
  const d = await gh.graphql(
    `query($id: ID!) { node(id: $id) { ... on ProjectV2 { id number title url items(first: 1) { totalCount } ${FIELDS_FRAGMENT} } } }`,
    { id: projectId });
  return d.node;
}

/**
 * Make the project's Status field carry our five options and create any
 * missing custom fields. Returns the field map used by the syncer.
 */
export async function ensureFields(gh, project, { log = () => {} } = {}) {
  let p = project.fields ? project : await loadProject(gh, project.id);
  const byName = () => Object.fromEntries(p.fields.nodes.map(f => [f.name, f]));
  let fields = byName();

  const status = fields['Status'];
  if (!status || !status.options) throw new Error('Project has no single-select "Status" field; refusing to guess.');
  const have = new Set(status.options.map(o => o.name));
  const missing = STATUS_OPTIONS.filter(o => !have.has(o.name));
  if (missing.length) {
    if (p.items.totalCount > 0) {
      throw new Error(`Status is missing options [${missing.map(o => o.name).join(', ')}] but the project already has ${p.items.totalCount} items. Add the options by hand in the project settings, so nothing loses its status.`);
    }
    // Empty project: safe to define the option set outright.
    const opts = STATUS_OPTIONS.map(o => ({ name: o.name, color: o.color, description: o.description }));
    log(`project: setting Status options → ${opts.map(o => o.name).join(' · ')}`);
    await gh.graphql(
      `mutation($fieldId: ID!, $opts: [ProjectV2SingleSelectFieldOptionInput!]!) {
         updateProjectV2Field(input: { fieldId: $fieldId, singleSelectOptions: $opts }) {
           projectV2Field { ... on ProjectV2SingleSelectField { id options { id name } } } } }`,
      { fieldId: status.id, opts });
  }

  for (const def of CUSTOM_FIELDS) {
    if (fields[def.name]) continue;
    log(`project: creating field "${def.name}" (${def.dataType})`);
    await gh.graphql(
      `mutation($pid: ID!, $name: String!, $type: ProjectV2CustomFieldType!) {
         createProjectV2Field(input: { projectId: $pid, dataType: $type, name: $name }) {
           projectV2Field { ... on ProjectV2FieldCommon { id name dataType } } } }`,
      { pid: p.id, name: def.name, type: def.dataType });
  }

  p = await loadProject(gh, p.id);
  fields = byName();
  const statusOpts = Object.fromEntries(fields['Status'].options.map(o => [o.name, o.id]));
  return {
    id: p.id, number: p.number, title: p.title, url: p.url,
    status: { id: fields['Status'].id, options: statusOpts },
    custom: Object.fromEntries(CUSTOM_FIELDS.map(d => [d.name, fields[d.name]?.id]).filter(([, id]) => id)),
  };
}

export async function addItem(gh, projectId, contentId) {
  const d = await gh.graphql(
    `mutation($pid: ID!, $cid: ID!) { addProjectV2ItemById(input: { projectId: $pid, contentId: $cid }) { item { id } } }`,
    { pid: projectId, cid: contentId });
  return d.addProjectV2ItemById.item.id;
}

export async function archiveItem(gh, projectId, itemId) {
  await gh.graphql(
    `mutation($pid: ID!, $iid: ID!) { archiveProjectV2Item(input: { projectId: $pid, itemId: $iid }) { item { id } } }`,
    { pid: projectId, iid: itemId });
}

/**
 * Set several field values in one request. `values` is [{fieldId, value}]
 * where value is {singleSelectOptionId} | {text} | {number} | {date}.
 */
export async function setItemFields(gh, projectId, itemId, values) {
  if (!values.length) return;
  const vars = { pid: projectId, iid: itemId };
  const decl = ['$pid: ID!', '$iid: ID!'];
  const parts = values.map((v, i) => {
    vars[`f${i}`] = v.fieldId; vars[`v${i}`] = v.value;
    decl.push(`$f${i}: ID!`, `$v${i}: ProjectV2FieldValue!`);
    return `s${i}: updateProjectV2ItemFieldValue(input: { projectId: $pid, itemId: $iid, fieldId: $f${i}, value: $v${i} }) { projectV2Item { id } }`;
  });
  await gh.graphql(`mutation(${decl.join(', ')}) { ${parts.join('\n')} }`, vars);
}

export function projectCachePath(dataDir) { return path.join(dataDir, 'project.json'); }
export function readProjectCache(dataDir) {
  try { return JSON.parse(fs.readFileSync(projectCachePath(dataDir), 'utf8')); } catch { return null; }
}
export function writeProjectCache(dataDir, p) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(projectCachePath(dataDir), JSON.stringify(p, null, 2) + '\n');
}
