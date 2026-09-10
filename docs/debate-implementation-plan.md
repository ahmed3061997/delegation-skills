# debate implementation plan

Status: implemented in `skills/debate/` on 2026-09-10.

## Confirmed requirements

- Discover installed agent CLIs and build a JSON catalog of agents and their models.
- Ask the user to select an agent, then select a model and effort level. Propose high by default only when verified for the selected model.
- Gather relevant codebase references for a technical debate.
- Delegate two read-only passes to the selected CLI, model, and effort; continue the session when the adapter exposes a session id.
- Review the first result for a provisional verdict.
- Search the web for supporting and contradictory evidence, then delegate again to suggest a final decision.
- Inspect the existing delegate for comparable behavior.
- Record the accepted workflow in the ADR and glossary.

## Existing package references

- [Skill workflow](../skills/delegate/SKILL.md): discovery, sequential selection, briefing, dispatch, review, and session continuation. Its single-task workflow stops before automatic rework.
- [Dispatch contract](../skills/delegate/references/dispatch-and-results.md): documented read-only profiles, explicit session IDs, process outcomes, and run artifacts.
- [Selection flow](../skills/delegate/references/selection-flow.md): model provenance and model-dependent effort choices.

Implementation inspection confirmed that [catalog.mjs](../skills/delegate/scripts/catalog.mjs) emits a versioned JSON catalog, [select.mjs](../skills/delegate/scripts/select.mjs) resolves model-dependent effort choices, and [dispatch.mjs](../skills/delegate/scripts/dispatch.mjs) accepts explicit sessions and read-only execution. [adapters.mjs](../skills/delegate/scripts/adapters.mjs) defines four adapters with session and read-only support. The implemented debate package reuses these modules through the bundled sibling skill.

[review.mjs](../skills/delegate/scripts/review.mjs) reports mechanical findings and optional check results. Its verdict is `findings-reported` or `no-findings`; it does not decide the merits of a technical argument. The debate skill therefore needs a separate semantic review contract.

## Design tree

The implementation settles these independent roots:

1. Debate semantics: one delegated participant must state a position, objections, alternatives, and uncertainty.
2. Package relationship: `debate` reuses the bundled `delegate` engine; it does not duplicate adapters or catalog ownership.
3. Execution authority: both passes are advisory and read-only; the orchestrator retains implementation authority.
4. Debate budget: exactly two delegated passes, with optional session continuation but no automatic retry or third pass.
5. Evidence policy: the orchestrator records inspected sources as support, contradiction, or limitation and preserves unresolved claims.

Selection UX, reference limits, output contracts, persistence, recovery, portability, and acceptance checks are documented in the skill and protocol references.

## Implemented flow

Discovery → user selection → bounded codebase reference packet → first read-only delegated analysis → orchestrator critique and provisional verdict → web evidence packet → second read-only delegated analysis → orchestrator review → final recommendation for the user.

Research should test the provisional verdict, including evidence against it. A successful process exit alone does not establish a sound technical conclusion.

## Design records

- [Accepted workflow ADR](debate/adr-0001-workflow.md)
- [Glossary](debate/glossary.md)

The implementation is in `skills/debate/`: `SKILL.md`, focused workflow/evidence/protocol references,
`scripts/protocol.mjs`, `scripts/debate.mjs`, and a dependency-free test suite. The CLI delegates through
`skills/delegate/scripts/dispatch.mjs`, preserving its verified adapters and `delegate.run.v1`
result contract. Installation uses the Skills CLI; installing both `delegate` and `debate` together
keeps the debate helper's sibling dispatch dependency available.
