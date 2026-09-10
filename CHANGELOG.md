# Changelog

All notable changes to this package are recorded here. Versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.1.0 — 2026-09-10

Evidence-informed technical debate skill added.

### Added

- `debate`, a two-pass read-only workflow for local references, provisional analysis,
  contradictory web evidence, and a final recommendation.
- Versioned reference, evidence, semantic review, and decision protocols with bounded packet helpers
  and tests.

## 1.0.0 — 2026-09-10

First release.

### Added

- **Agent registry** covering fourteen CLIs: Claude Code, Cline, Codex, OpenCode, Antigravity, Grok,
  Kimi, Qoder, Vibe, Cursor Agent, Pi, Aider, GitHub Copilot CLI, and Warp. Every probe is chosen so
  it cannot be read as a prompt by the CLI it targets.
- **Discovery catalog** (`delegate.catalog.v1`) cached at
  `${XDG_CACHE_HOME:-~/.cache}/delegate/catalog.json`, published atomically, valid for 24 hours
  and invalidated when an executable's path or on-disk fingerprint moves. A failed refresh returns
  the previous catalog labelled stale rather than nothing.
- **Selection** in one direction — agent, then model, then effort — with the provenance of every
  identifier carried through to the user: live listing, cached catalog, curated alias, manual entry,
  or CLI default. Hidden models are excluded. Effort defaults to `high` only where high is verified
  for that exact agent and model.
- **Dispatch adapters** for the four CLIs that could be exercised locally, each with exactly two
  permission profiles (write and read-only), stated on every invocation including resumed turns. The
  brief always travels on stdin.
- **Run results** (`delegate.run.v1`) written on every outcome once the brief validates, with
  change accounting that separates the agent's edits from work already in the tree.
- **Review** (`delegate.review.v1`) that re-runs the project's own checks and records findings.
  Its verdict is `findings-reported` or `no-findings` — never `approved`.
- **References**: selection flow, writing the brief, dispatch and results, review and report, an ADR
  covering the architecture, and a glossary.
- **Tests**: five suites, no dependencies and no network. Dispatch is exercised against fake agent
  binaries on a throwaway PATH, covering cancellation, watchdog timeouts, non-zero exits, malformed
  events, paths containing spaces, and partial-artifact preservation.
- **Packaging**: plugin and marketplace manifests, `install.sh`, and `verify.sh`.

### Known limits

- Ten of the fourteen registry entries are discovery-only. They are found and described but cannot
  receive a task, because no adapter was written without the CLI in hand.
- A launcher shim whose bytes do not change when its package is upgraded will not invalidate the
  catalog before the 24-hour TTL. `--refresh` forces it, and the version actually launched is
  recorded in every run result.
- Read-only mode is enforced by each agent, not by this skill. The change report is a tripwire that
  makes a violation visible; it is not a boundary.
- macOS and Linux only. The code carries Windows handling for shims and process trees, but nothing
  here has been verified on Windows.
