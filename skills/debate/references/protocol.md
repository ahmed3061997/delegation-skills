# Debate protocol

The helper emits and consumes four versioned documents:

| Document | Purpose |
| --- | --- |
| `debate.reference.v1` | bounded local files, hashes, truncation, and omitted paths |
| `debate.evidence.v1` | inspected web sources mapped to claims and relation |
| `debate.review.v1` | mechanical completeness review of a delegated pass |
| `debate.decision.v1` | optional orchestrator-owned recommendation record |

Run results retain the existing `delegate.run.v1` schema. The debate review never changes a run
status and never turns a process result into an approval. A review is `unverified` when the run did not
complete or the required final evidence is absent; otherwise it is `reviewable`, subject to the
orchestrator's semantic judgment.

Analysis reports use these level-2 headings: `Position`, `Claims`, `Objections`, `Alternatives`,
`Recommendation`, `Confidence`, and `Unknowns`. Claims should have stable ids (`C1`, `C2`, …), and
evidence sources should have stable ids (`E1`, `E2`, …). The parser ignores unknown headings but keeps
the original final report in the run artifact.
