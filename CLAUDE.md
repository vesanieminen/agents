# CLAUDE.md

Notes for agents working in this repository. The point of this file is that you
can move tickets on the project board without rediscovering how — read
"Moving a ticket" and follow it.

## The project board

Issues in this repo feed a **user-level GitHub Project**:
`https://github.com/users/vesanieminen/projects/1` — project #1, owned by the
user `vesanieminen`, not by this repository. It is public.

An **Auto-add to project** workflow is configured on the board for this repo,
so any issue you create here lands on it within seconds. Auto-add is
forward-only; it never backfills issues that predate it.

The `Status` field is a single select with these options, confirmed by writing
each one:

    Backlog · Ready · In progress · In review · Done

## What is reachable from an agent session

**Issues: yes.** REST, served normally by the GitHub MCP tools
(`mcp__github__issue_write`, `issue_read`, `list_issues`). Creating an issue is
how you put a ticket on the board.

**The board directly: no.** Every Projects v2 operation — reading items or
field options, adding an item, setting Status — is GraphQL-only, and there is
no REST equivalent (the classic Projects REST API does not cover Projects v2).
Remote sessions have GraphQL blocked at the proxy:

> This GraphQL query is not enabled for this session — only the pinned set of
> PR-review operations is served.

That is a transport restriction, not an auth problem: `GITHUB_TOKEN` in the
session env is valid and fine for REST. Mutations are blocked along with
queries, and the board's visibility makes no difference. Do not burn turns
retrying `curl`, `gh api graphql`, or reworded queries.

**Scraping the board over the web: no.** It is public, so `WebFetch` returns
200 rather than 404, but the page is client-side rendered — you get the project
title and nothing else. To learn the board's current state, ask the user.

## Moving a ticket

`.github/workflows/project-status.yml` does the board write on a GitHub runner,
which is not behind your proxy and holds a token that can write to the project.
You reach it through REST, which you do have. Two routes:

**Route 1 — labels (normal use).** Set a `status:<option>` label on the issue:

    mcp__github__issue_write(method="update", owner="vesanieminen",
      repo="agents", issue_number=<n>, labels=["status:in progress"])

The `issues: [labeled]` trigger fires and the workflow sets that issue's card
to the matching option. Matching is case-insensitive, so `status:in progress`
finds `In progress`. Labels without the `status:` prefix are ignored. Note that
`issue_write` **replaces** the label set — include any labels that must survive.

**Route 2 — dispatch (testing, or moving without touching labels).**

    mcp__github__actions_run_trigger(method="run_workflow", owner="vesanieminen",
      repo="agents", workflow_id="project-status.yml", ref="main",
      inputs={"issue": "1", "status": "In review"})

`ref` must be a branch whose copy of the workflow you want to run; the file must
also exist on the default branch for dispatch to be offered at all.

**Sequencing matters.** If you fire several transitions at once the runs race
and last-writer-wins leaves the card somewhere arbitrary. Dispatch one, wait for
success, then dispatch the next.

## Verifying a run

Use `scripts/wait-for-run.sh <previous-run-id>`, passing the newest run ID from
*before* your dispatch (or `0`). It blocks until a newer run completes, then
prints the conclusion and the line the run wrote:

    run #7 (33674530065): success
    Issue #1 -> Status: In review
    RUNID=33674530065

Feed that `RUNID` to the next call as `<previous-run-id>`.

Prefer this over `mcp__github__actions_list` for polling: the MCP listing
returns full commit messages for every run and will eat your context in a few
calls. It is REST underneath, so it works despite the GraphQL block.

**Log gotcha:** a job log replays the step's shell source before executing it,
so grepping for `::error::` matches `echo` statements that never ran — a
successful run will appear to contain errors. The runner wraps those echoed
source lines in an ANSI colour escape (`\033[36;1m`) and genuine step output
has none, so filter on the escape. Filtering on unexpanded `$` instead is not
enough: a literal message with no variables in it survives that test. The
script already handles this.

On failure, read the log before changing anything: each call reports its own
name, so the log distinguishes a missing token, a missing `Status` field, an
unknown status name (it lists the valid options), and a permissions refusal.

## Why it takes a runner at all

Projects v2 addresses everything by opaque node ID, and a single-select field
cannot be set by the option's name — the write needs four IDs, none guessable:
project, item, field, option. So every run reads before it writes: query the
project for its ID, the `Status` field ID and the full option list, match your
status string against the option names, resolve the issue's `node_id` via REST
(the join key between the two APIs), call `addProjectV2ItemById` to get the item
ID (idempotent — it returns the existing card), then
`updateProjectV2ItemFieldValue` with all four.

Board coordinates are configurable in the workflow's `env:` block:
`PROJECT_OWNER`, `PROJECT_NUMBER`, `STATUS_FIELD`, `LABEL_PREFIX`.

## Prerequisites (already satisfied — check here if it breaks)

- **The workflow is on the default branch.** `issues`-triggered workflows only
  run from there.
- **`PROJECTS_TOKEN` holds a classic PAT** with the `project` and `repo`
  scopes, as a repository Actions secret. Do not suggest a fine-grained PAT: its
  Projects permission appears only under the *Organizations* tab, so a
  user-owned project cannot be granted it at all. The measured split for the
  default `GITHUB_TOKEN` on this public board is that **reads succeed** and
  **writes return** `{"type":"FORBIDDEN","message":"Resource not accessible by
  integration"}`. A run's first log line says which token it used.

Label→status is one-directional: moving a card by hand does not update the
issue's label, so the two can drift. Closing that loop would need a second
workflow on `projects_v2_item` events; none exists today.
