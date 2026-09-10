# ADR 0001 — Evidence-informed delegated technical debate

Status: accepted and implemented.

## Context

The requested skill combines local CLI discovery and user selection with two delegated analyses separated by orchestrator review and web research. The existing delegate is a candidate source of discovery and execution behavior, but its workflow reports and stops after one task.

## Decision

Let debate own the debate workflow: collect bounded local references, request an initial read-only
analysis, review its claims, research supporting and contradictory evidence, and request one final
read-only recommendation. Keep the process outcome separate from the strength of the technical verdict.

The package reuses the bundled delegate engine for catalog discovery, selection, adapter command
construction, process lifecycle, and `delegate.run.v1` artifacts. The debate package owns only
debate-specific briefs, reference/evidence packets, semantic completeness review, and the orchestrator's
final judgment. This keeps one source of truth for CLI flags and permission profiles while retaining a
separate contract for argument quality.

The normal budget is two passes. Session continuation is used when available, but a failed pass is not
retried automatically and no third pass is started by the skill. Both passes use the engine's read-only
profile. Web research is an orchestrator action and must include contradictory evidence where available.

## Consequences to evaluate

- Reusing delegate avoids duplicating CLI-specific behavior and makes adapter safety fixes apply to both workflows; a manually copied debate skill must be installed alongside delegate.
- A standalone implementation would be independently portable but would create a second catalog, adapter, and permission-profile maintenance surface.
- Two passes bound the normal workflow but may end with unresolved questions.
- Additional passes may resolve questions but are an explicit new user request, not an automatic recovery path.
- Searching only for support for the provisional verdict risks reinforcing an incorrect conclusion.

## Acceptance

The decision is implemented by `skills/debate/`; its packet and review contracts are covered by
the package tests. Revisit the dependency choice only if the skills are distributed independently or
the delegate adapter contract changes.
