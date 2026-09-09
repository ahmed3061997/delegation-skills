# ADR 0001 — Evidence-informed delegated technical debate

Status: proposed; awaiting design interview decisions.

## Context

The requested skill combines local CLI discovery and user selection with two delegated analyses separated by orchestrator review and web research. The existing delegate-skill is a candidate source of discovery and execution behavior, but its workflow reports and stops after one task.

## Proposed decision

Let debate-skill own the debate workflow: collect references, request an initial analysis, review its claims, research supporting and contradictory evidence, and request a final recommendation. Keep the process outcome separate from the strength of the technical verdict.

The relationship to delegate-skill, permission profile, round limit, debate roles, and evidence failure policy are still open. No dependency architecture has been accepted.

## Consequences to evaluate

- Reusing delegate-skill could avoid duplicating CLI-specific behavior but introduces an installation and compatibility dependency.
- A standalone package could be installed independently but must maintain its own delegation infrastructure.
- Extracting shared infrastructure could reduce duplication but expands the scope to the existing package and its installer.
- Two passes bound the normal workflow but may end with unresolved questions.
- Additional passes may resolve questions but require explicit stopping and cost controls.
- Searching only for support for the provisional verdict risks reinforcing an incorrect conclusion.

## Acceptance

Update this record after the user settles the design tree. Do not label recommendations as accepted decisions.
