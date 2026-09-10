# Dispatch and results

## Invocation

```bash
node "<skill-dir>/scripts/dispatch.mjs" --agent <key> --brief brief.txt [options]
cat brief.txt | node "<skill-dir>/scripts/dispatch.mjs" --agent <key>
```

| Option | Meaning |
| --- | --- |
| `--agent <key>` | Required. One of the dispatchable agents from `select.mjs agents`. |
| `--brief <file>` | The brief. Omit to read it from stdin. |
| `--model <id>` | Model id. Required for agents with no usable default (OpenCode). |
| `--effort <level>` | Reasoning effort, validated against the agent and model. |
| `--cd <dir>` | Working directory for the child. Defaults to the current directory. |
| `--read-only` | The agent's read-only/plan profile: analysis, no edits. |
| `--session <id>` | Continue a specific session. Send only a delta brief. |
| `--resume-last` | Continue the most recent session. Global to the CLI, not per repository. |
| `--timeout <dur>` | Watchdog, off by default. `h`/`m`/`s`, e.g. `45m`, `2h`. |
| `--out-dir <dir>` | Artifact directory. Defaults to a fresh directory under the system temp dir. |
| `--skip-git-repo-check` | Codex only: allow running outside a git repository. |
| `--refresh-catalog` | Rebuild the agent catalog before resolving the selection. |

Implementation runs routinely need one to two hours. The watchdog is off by default because a kill
mid-edit is worse than a slow run; set `--timeout` when you need a bound, and expect status
`timeout` if it fires.

## Permission profiles

Each adapter has exactly two, and the one in force is named in the result.

| Agent | Write profile | Read-only profile |
| --- | --- | --- |
| Claude Code | `acceptEdits`, tools limited to Read/Glob/Grep/Edit/Write/shell, MCP and skills off, an inline settings file denying `git commit`, `git push`, and re-entry into this skill | `plan` mode with Read/Glob/Grep only |
| Codex | `workspace-write` sandbox | `read-only` sandbox |
| OpenCode | `build` agent with `--auto` | `plan` agent, never `--auto` |
| Cursor Agent | `--force` with `--trust` | `--mode plan`, no `--force` |

Two things follow from this table. `--trust` means Cursor never stalls on a workspace-trust prompt,
so point `--cd` only at a repository you trust. And `--auto` means OpenCode auto-approves
permissions that are not explicitly denied, which is what makes a headless run possible at all —
your diff review is the check on it, which is why this skill will not commit for you.

There is no third, wider profile, and no retry that reaches for one. A run that fails on permissions
fails, and you decide what to do about it.

## The result

`<out-dir>/result.json`, schema `delegate.run.v1`:

| Field | Meaning |
| --- | --- |
| `status` | See the table below. |
| `exitCode`, `signal` | The agent's own exit code, or 128+signal if it died on one. |
| `agent`, `label`, `agentVersion` | Which agent ran, and which build of it. |
| `requested` | Exactly what you asked for, before resolution. |
| `resolved` | What it resolved to: model and its source, effort, its mechanism, whether it was verified, and the auth state at dispatch. |
| `reportedModel` | The model the agent said it used, where it reports one. Compare it with `resolved.model`. |
| `permissionProfile` | Name and description of the profile in force. |
| `command` | The exact binary and argv, for audit. |
| `sessionId` | Pass to `--session` to continue this exact run. |
| `finalMessage` | The agent's closing report. A claim, not evidence. |
| `changes` | Working-tree accounting; see below. |
| `artifacts` | Paths to `brief.txt`, `events.jsonl`, `final.txt`, `stderr.txt`, `result.json`, and Claude's `settings.json`. |
| `warnings` | Selection-time warnings: manual model ids, unknown auth, a stale catalog. |
| `review` | `null` until `review.mjs` fills it in. |

### Statuses

| Status | Exit | Meaning |
| --- | --- | --- |
| `completed` | 0 | Exited cleanly with a report. Still needs review. |
| `no_output` | 0 | Exited cleanly with nothing to show. There is nothing to review — treat as unverified. |
| `failed` | agent's own | Non-zero exit, a launch failure, or a clean exit whose own result event reported an error. |
| `timeout` | 124 | The watchdog fired. Partial work is preserved. |
| `aborted` | 128+signal | The dispatcher itself was killed; the agent was killed with it. |
| `auth_failed` | 4 | Authentication is confirmed failed. Nothing was dispatched. |
| `agent_unavailable` | 127 | The binary vanished between discovery and dispatch. |

Exit 2 is a usage error or a rejected selection, and writes no result file. Exit 3 is an agent that
is installed but has no dispatch adapter. A poller that sees a non-zero exit and no `result.json` is
looking at one of those two.

### Change accounting

`changes` compares `git status --porcelain` before and after:

- `created` — dirty after but not before. The agent's work.
- `preexisting` — dirty before the run started.
- `alsoModified` — dirty both before and after. **Cannot be attributed.** Review those paths
  separately; some of what is there was already yours.
- `attributionUncertain` — true when `alsoModified` is non-empty, or when git could not report.
- `gitAvailable` — false means no attribution is possible at all. That is "unknown", never "clean".

Artifacts live under the system temp directory by default, so nothing this skill writes shows up in
the change report.

## Waiting for completion

The dispatcher blocks until the agent exits. On Claude Code, run it with `run_in_background: true`
and you are notified on completion. Elsewhere, run it in the foreground, or background it and poll
for `result.json` having a `status`.

A run is done when the process has exited and the result file is written. Read the working tree, not
a progress line.

## When something goes wrong

- **`auth_failed`** — the CLI says it is not logged in. Tell the user which login command to run.
  Note that *unknown* authentication is different: that run proceeds, with a warning.
- **`timeout`** — partial work is on disk and in the change report. Inspect the tree before
  re-dispatching; the session id still works for a follow-up.
- **`aborted`** — something killed the dispatcher. The agent was killed with it, possibly mid-edit.
  Inspect the tree before doing anything else.
- **`no_output`** — the process was happy and produced nothing. Do not report this as success.
- **Malformed events** — non-JSON lines are preserved verbatim in `events.jsonl` and otherwise
  ignored. A single bad line never fails a run.
- **A model that was not in the listing** — accepted where the agent allows manual ids, and recorded
  as `manual` with a warning. If the run then failed at the provider, the typo is the likely cause.
