---
name: debate
description: >-
  Run a bounded, evidence-informed technical debate about an engineering decision: gather local
  references, choose an installed delegable agent, obtain an initial analysis, test its provisional
  verdict with web evidence, and obtain a final recommendation. Use when the user wants competing
  technical arguments or decision support; do not use for direct implementation, ordinary code
  review, or open-ended research without a concrete decision.
license: MIT
compatibility: >-
  macOS and Linux. Requires Node.js 18 or newer and the bundled delegate for verified agent
  discovery and dispatch. Web search is performed by the orchestrator's available browsing tool.
metadata:
  version: 1.0.0
---

# Debate Skill

You are the **orchestrator**. This skill helps the user make a technical decision; it does not
authorize implementation. Keep the process outcome separate from the strength of the conclusion:
a successful child process is not evidence that its argument is correct.

## Boundaries

- Ask the user for the decision question and acceptance criteria if they are not already clear.
- Use the bundled `delegate` for catalog discovery, sequential selection (agent → model →
  effort), and read-only dispatch. Ask the user; never silently choose a participant.
- The normal workflow has exactly two delegated passes: an initial analysis and a final
  recommendation. Continue a session when the adapter reports a session id; do not retry a failed
  pass or substitute an agent, model, effort, or permission profile.
- Both passes are advisory and read-only. Do not grant edit, shell, commit, push, or external-service
  authority to the child. The final recommendation is not approval to change code.
- Research both support and contradiction. Record URLs, source titles, the claims they bear on, and
  limitations; do not present a search result or an agent's assertion as proof.

## Workflow

1. Clarify the decision, alternatives already under consideration, constraints, and what would make
   the decision reversible or successful.
2. Discover and select a dispatch-capable agent, then its model, then its effort. Propose `high` only
   when the catalog verifies it for that exact selection.
3. Create a bounded local reference packet. Explicit files and query matches are supported by the
   helper below; exclude secrets and keep the packet small enough for the child to reason over.

   ```bash
   node "<skill-dir>/scripts/debate.mjs" references \
     --cd /path/to/repo --goal-file decision.md --file src/module.ts --query "interface Name" \
     --out /tmp/debate-references.json
   ```

4. Run the initial pass with a generated brief and the delegate dispatcher. The helper can do
   both steps while preserving the chosen selection:

   ```bash
   node "<skill-dir>/scripts/debate.mjs" dispatch initial \
     --references /tmp/debate-references.json --agent <key> --model <id> --effort <level> \
     --cd /path/to/repo --out-dir /tmp/debate-initial
   ```

5. Inspect the result and make an independent provisional judgment. Use the semantic review helper
   as a completeness check, not as a substitute for judgment:

   ```bash
   node "<skill-dir>/scripts/debate.mjs" review initial \
     --result /tmp/debate-initial/result.json --out /tmp/debate-initial/review.json
   ```

6. Search the web for primary, current, and contradictory evidence. Put the result in an
   `debate.evidence.v1` JSON packet. Read [evidence-policy.md](references/evidence-policy.md)
   for the required fields and handling of uncertainty.
7. Run the final pass with the same selection. It receives the reference packet, evidence packet,
   and provisional review, and continues the initial session when possible:

   ```bash
   node "<skill-dir>/scripts/debate.mjs" dispatch final \
     --references /tmp/debate-references.json --first-result /tmp/debate-initial/result.json \
     --review /tmp/debate-initial/review.json --evidence /tmp/debate-evidence.json \
     --cd /path/to/repo --out-dir /tmp/debate-final
   ```

8. Review the final result, then report the recommendation, rationale, confidence, evidence for and
   against, unresolved questions, and any safe next step. State run failures separately. Leave the
   workspace unchanged and stop; do not implement, commit, revert, or automatically ask for a third
   pass.

The generated brief requires these non-empty sections: `Position`, `Claims`, `Objections`,
`Alternatives`, `Recommendation`, `Confidence`, and `Unknowns`. The report parser and review record
are documented in [protocol.md](references/protocol.md). The full workflow and recovery rules are in
[workflow.md](references/workflow.md).

