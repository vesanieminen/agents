#!/usr/bin/env bash
# Wait for the newest workflow_dispatch run of a workflow to finish, then print
# its conclusion and the line it wrote.
#
#   scripts/wait-for-run.sh <previous-run-id> [workflow-file]
#
# Pass the run ID you saw *before* dispatching (or 0 for none) so a run that is
# still queued is not mistaken for the finished previous one. Requires a token
# in GITHUB_TOKEN with repo read access; REST only, so it works from an agent
# session where GraphQL is blocked.
set -uo pipefail

prev="${1:-0}"
workflow="${2:-project-status.yml}"
repo="${GITHUB_REPOSITORY:-vesanieminen/agents}"
api="https://api.github.com/repos/$repo"
auth=(-H "Authorization: bearer $GITHUB_TOKEN")

for _ in $(seq 1 90); do
  run=$(curl -sS "${auth[@]}" "$api/actions/workflows/$workflow/runs?event=workflow_dispatch&per_page=1")
  id=$(jq -r '.workflow_runs[0].id' <<<"$run")
  status=$(jq -r '.workflow_runs[0].status' <<<"$run")
  number=$(jq -r '.workflow_runs[0].run_number' <<<"$run")
  conclusion=$(jq -r '.workflow_runs[0].conclusion' <<<"$run")

  if [ "$status" = "completed" ] && [ "$id" != "$prev" ]; then
    job=$(curl -sS "${auth[@]}" "$api/actions/runs/$id/jobs" | jq -r '.jobs[0].id')
    # The log replays the step's own source before running it, so a naive grep
    # for ::error:: matches echo statements that never ran. The runner wraps
    # those echoed lines in an ANSI colour code; genuine output has none.
    line=$(curl -sSL "${auth[@]}" "$api/actions/jobs/$job/logs" 2>/dev/null \
      | grep -aE 'Status:|::error::' | grep -av $'\033\[' | tail -2 \
      | sed 's/.*Z //' | tr -d '\r')
    echo "run #$number ($id): $conclusion"
    [ -n "$line" ] && echo "$line"
    echo "RUNID=$id"
    exit 0
  fi
done

echo "timed out waiting for a new run (last seen: #$number $status)" >&2
exit 1
