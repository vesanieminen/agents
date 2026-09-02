# CLAUDE.md

Notes for agents working in this repository.

## The project board

Issues in this repo feed a **user-level GitHub Project**:
`https://github.com/users/vesanieminen/projects/1` (project #1, owned by the
user `vesanieminen`, not by this repository). The board is public.

An **Auto-add to project** workflow is configured on the board for this repo,
so any issue you create here appears on it automatically, usually within
seconds. Auto-add is forward-only — it never backfills issues that existed
before the workflow was turned on.

## What you can and cannot do

**You can create and update issues.** Issues are a REST API, served normally by
the GitHub MCP tools (`mcp__github__issue_write`, `issue_read`, `list_issues`).
Filing an issue here is the supported way to put a ticket on the board.

**You cannot touch the board directly.** Every Projects v2 operation — reading
items, reading field option IDs, setting Status, adding an item explicitly — is
GraphQL-only. There is no REST equivalent; the classic Projects REST API does
not cover Projects v2. Remote Claude Code sessions have GraphQL blocked at the
proxy:

> This GraphQL query is not enabled for this session — only the pinned set of
> PR-review operations is served.

This is a transport restriction, not an auth problem. `GITHUB_TOKEN` in the
session environment is valid and works fine for REST. Do not spend turns
retrying `curl`, `gh api graphql`, or different queries — mutations are blocked
along with queries, and the board's visibility has no bearing on it.

**Do not try to read the board over the web either.** It is public, so
`WebFetch` on the project URL returns 200 instead of 404, but the board is
client-side rendered: the HTML carries the project title and nothing else. No
columns, no items. Ask the user what is on the board rather than guessing.

## Moving an item to a status

Use the label bridge in `.github/workflows/project-status.yml`. Add a label of
the form `status:<option>` to an issue — `status:ready`, `status:in progress` —
and the workflow sets that issue's board item to the matching Status option.
The suffix is matched case-insensitively against the option names on the board,
and the item is added to the board first if it is not already there.

This works because labels are REST (so you can set them) while the board write
happens on a GitHub runner, outside the session proxy that blocks your GraphQL.

Requirements, all of which are the user's to satisfy — you cannot do any of
them yourself:

- **The workflow must be on the default branch.** Workflows triggered by
  `issues` events only run from the default branch.
- **A `PROJECTS_TOKEN` secret must exist**: a **personal access token
  (classic)** with the `project` and `repo` scopes. Do not reach for a
  fine-grained PAT — its Projects permission is exposed only under the
  *Organizations* tab, so for a user-owned project like this one it cannot be
  granted, and an account with no organizations has no way to set it at all.
  The split in what the default token can do is narrower than GitHub's docs
  suggest, and worth knowing exactly, because it was measured on this board
  rather than assumed:

  - **Reads work** with the default `GITHUB_TOKEN`, because this project is
    public. A run with no secret logs `Read project #1 and its Status field.`
  - **Writes do not.** `addProjectV2ItemById` returns
    `{"type":"FORBIDDEN","message":"Resource not accessible by integration"}`.

  So a workflow that only inspects the board may run unauthenticated, but
  anything that moves an item needs the PAT. The `repository-projects`
  permission `GITHUB_TOKEN` carries is for the old classic project boards, not
  Projects v2, and does not help. The workflow falls back to `GITHUB_TOKEN`
  when the secret is absent and names the failing operation in its log.

Configuration lives in the `env:` block at the top of the workflow:
`PROJECT_OWNER`, `PROJECT_NUMBER`, `STATUS_FIELD`, `LABEL_PREFIX`. A
`workflow_dispatch` trigger takes an issue number and a status name, for
testing without labeling anything.

If a status label produces no movement on the board, read the workflow run log
before changing anything — it distinguishes a missing token, a missing Status
field, and a status name that is not one of the board's options.
