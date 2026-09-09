# debate-skill implementation plan

Status: discovery and design interview in progress. No implementation is authorized by this draft.

## Confirmed requirements

- Discover installed agent CLIs and build a JSON catalog of agents and their models.
- Ask the user to select an agent, then select a model and effort level. Propose high by default; handling unsupported levels remains to be settled.
- Gather relevant codebase references for a technical debate.
- Delegate the debate to the selected CLI, model, and effort.
- Review the first result for a provisional verdict.
- Search the web for evidence, then delegate again to suggest a final decision.
- Inspect the existing delegate-skill for comparable behavior.
- Develop the plan through a grilling interview, recording ADRs and a glossary directly because domain-modeling is unavailable.

## Existing package references

- [Skill workflow](../skills/delegate-skill/SKILL.md): discovery, sequential selection, briefing, dispatch, review, and session continuation. Its single-task workflow stops before automatic rework.
- [Dispatch contract](../skills/delegate-skill/references/dispatch-and-results.md): documented read-only profiles, explicit session IDs, process outcomes, and run artifacts.
- [Selection flow](../skills/delegate-skill/references/selection-flow.md): model provenance and model-dependent effort choices.

Implementation inspection confirms that [catalog.mjs](../skills/delegate-skill/scripts/catalog.mjs) emits a versioned JSON catalog, [select.mjs](../skills/delegate-skill/scripts/select.mjs) resolves model-dependent effort choices, and [dispatch.mjs](../skills/delegate-skill/scripts/dispatch.mjs) accepts explicit sessions and read-only execution. [adapters.mjs](../skills/delegate-skill/scripts/adapters.mjs) defines four adapters with session and read-only support. These are reuse candidates, not an accepted dependency design.

[review.mjs](../skills/delegate-skill/scripts/review.mjs) reports mechanical findings and optional check results. Its verdict is `findings-reported` or `no-findings`; it does not decide the merits of a technical argument. Debate-skill therefore needs a separate semantic review contract.

## Design tree

The first round settles these independent roots:

1. Debate semantics: critique a proposal, compare alternatives, or use separate opposing participants?
   - Unblocks initial brief, argument structure, and verdict criteria.
2. Package relationship: depend on delegate-skill, bundle a standalone implementation, or extract shared infrastructure?
   - Unblocks installation, compatibility, catalog ownership, and test boundaries.
3. Execution authority: advisory read-only analysis or permission to run experiments and edit code?
   - Unblocks reference gathering, workspace handling, and validation requirements.
4. Debate budget: two delegated passes or an iterative loop?
   - Unblocks session continuity, timeout, retry, and termination policies.
5. Evidence policy: seek supporting and contradictory evidence; what happens when research cannot settle a claim?
   - Unblocks research contract, evidence quality checks, and uncertainty reporting.

After those roots settle, address selection UX, reference limits and freshness, output contracts, persistence, recovery, portability, and acceptance checks. Ask only questions whose prerequisites have been settled.

## Proposed flow, pending decisions

Discovery → user selection → codebase reference packet → first delegated analysis → orchestrator critique and provisional verdict → web evidence packet → second delegated analysis → orchestrator review → final recommendation for the user.

Research should test the provisional verdict, including evidence against it. A successful process exit alone does not establish a sound technical conclusion.

## Design records

- [Proposed architecture ADR](debate-skill/adr-0001-workflow.md)
- [Working glossary](debate-skill/glossary.md)

The final implementation plan will specify the accepted architecture, file changes, contracts, failure behavior, and validation after the interview. Implementation begins only after shared understanding is confirmed.
