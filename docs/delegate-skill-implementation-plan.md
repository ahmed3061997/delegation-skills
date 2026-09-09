# delegate-skill implementation plan

## Summary

Create a self-contained skill that discovers installed agent CLIs, prompts for an agent followed by model and effort, delegates a bounded task, and reviews the result without committing or automatically requesting rework.

Support macOS and Linux across agent hosts, using native question tools where available and numbered text prompts otherwise.

## Package and discovery

- Create `delegate-skill/` in the current workspace with `SKILL.md`, Node.js helpers, adapter tests, and supporting references. Require Node.js 18 or newer.
- Adapt the installed delegation skills’ discovery, brief, dispatch, and result-handling patterns. Bundle required code; do not depend on other installed skills or alter them.
- Include all 14 registry entries: Claude, Cline, Codex, OpenCode, Antigravity, Grok, Kimi, Qoder, Vibe, Cursor, Pi, Aider, Copilot, and Warp.
- Implement each adapter against verified CLI help or official documentation. Entries without verified local execution remain discoverable but unavailable for dispatch.
- Probe known executable names through `PATH`, recording resolved path, version, authentication status, and capabilities. Never use a probe that could be interpreted as a task.
- Store the catalog under `${XDG_CACHE_HOME:-~/.cache}/delegate-skill/catalog.json`. Refresh after 24 hours, on executable path/version changes, or explicit refresh. Write atomically and label stale data when refresh fails.

## Selection and execution

- Accept the task and an optional working directory; default to the current directory. Ask for a task only when none was supplied.
- First prompt for an installed, dispatch-capable agent. Then prompt for model and effort, showing only relevant choices.
- Distinguish live listings, cached catalogs, curated aliases, and unknown availability. Exclude hidden models. Support a manual model ID or configured CLI default where available; never invent identifiers.
- Default effort to `high` when verified for the selected model. Otherwise offer verified alternatives or the CLI default. Translate effort into native flags, OpenCode variants, or verified Cursor model parameters.
- Keep credentials out of catalogs and logs. Unknown authentication is distinct from confirmed authentication failure.
- Build a self-contained brief containing the goal, constraints, relevant context, expected deliverable, and applicable project checks. Instruct the child not to commit or push.
- Dispatch through argument arrays and stdin using explicit adapter permission profiles. Do not introduce permission-bypass retries or silently switch agent, model, or effort.
- Execute in the selected directory. Record existing changes before launch. Capture output and process status in temporary run artifacts; wait for process exit before declaring completion.
- On cancellation, terminate the child process tree and preserve partial results. Report authentication failures, unsupported options, missing output, and nonzero exits without automatic retries.

## Interfaces and review

- Define a versioned catalog containing agent identity, executable information, authentication state, dispatch availability, model entries, effort capabilities, discovery source, and timestamps.
- Give adapters a common interface for discovery, selection validation, command construction, and result normalization.
- Define a versioned run result containing requested and resolved selections where reported, status, exit code, session identifier, final message, artifact paths, and review findings.
- For coding tasks, inspect changes against the brief and rerun applicable project checks. Preserve pre-existing work and report attribution uncertainty where necessary.
- For other tasks, inspect the requested deliverable against its acceptance criteria.
- Report findings and stop. Leave edits available for the user; do not commit, roll back, or initiate rework.
- Add an ADR covering the agreed architecture and a glossary defining agent, adapter, model, effort, catalog, brief, run, and review.

## Validation and acceptance

- Test discovery, missing executables, unknown authentication, cache expiration/invalidation, stale fallback, and malformed probe output.
- Test selection behavior: hidden models, aliases, manual IDs, configured defaults, supported `high`, and unsupported or unknown effort.
- Test adapter argument construction, stdin delivery, paths with spaces, process cancellation, nonzero exits, malformed results, and preservation of partial artifacts.
- Test review behavior with clean and already-modified workspaces, failed checks, and non-code deliverables.
- Use official documentation and realistic command/output fixtures for every dispatch adapter. Clearly identify adapters without live integration verification.
- Perform safe discovery checks for the four installed CLIs. Paid task execution is not required for this plan’s validation baseline.
- Validate skill metadata, references, and both native-question and numbered-text selection flows.

Implementation remains confined to the workspace package; installation and global skill changes are separate work.
