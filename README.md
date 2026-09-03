# agents

Experiments in running Claude Code agents against GitHub, and the tooling that
came out of them.

## claude-board

A live Kanban board of your Claude Code sessions. Hooks post to a small local
daemon; the daemon keeps one issue per session on a GitHub Projects board, with
the column saying what the session needs from you. Lives in
[`claude-board/`](claude-board/) and is published to
[vesanieminen/claude-board](https://github.com/vesanieminen/claude-board) by the
`claude-board publish` workflow.

![Dashboard, light theme](claude-board/docs/screenshots/dashboard-light.png)

![Dashboard, dark theme](claude-board/docs/screenshots/dashboard-dark.png)

Each card opens to an issue the daemon rewrites on every sync — resume command,
current prompt, Claude's last message, files touched, and a timeline:

![Issue body for a Needs-you session](claude-board/docs/screenshots/issue.png)

The CLI has `status`, `doctor` and `install-hooks`:

![claude-board status](claude-board/docs/screenshots/cli-status.png)

![claude-board doctor](claude-board/docs/screenshots/cli-doctor.png)

See [claude-board/README.md](claude-board/README.md) for setup.

## Project board bridge

Remote Claude Code sessions can create issues but cannot run GraphQL, so they
cannot move cards on a GitHub Projects board. `.github/workflows/project-status.yml`
does the board write on a runner: label an issue `status:<option>` and its card
moves. [`CLAUDE.md`](CLAUDE.md) documents the routes for agents;
`scripts/wait-for-run.sh` waits on a dispatched run and prints what it wrote.
