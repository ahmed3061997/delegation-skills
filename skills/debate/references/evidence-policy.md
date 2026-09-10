# Evidence packet policy

The orchestrator creates a JSON object with schema `debate.evidence.v1`:

```json
{
  "schema": "debate.evidence.v1",
  "question": "the decision question",
  "sources": [
    {
      "id": "E1",
      "title": "source title",
      "url": "https://example.test/primary-source",
      "relation": "supports",
      "claims": ["C1"],
      "summary": "A short paraphrase of the relevant fact",
      "limitations": "Scope, date, or uncertainty"
    }
  ]
}
```

`relation` is one of:

- `supports`: the source makes a cited claim more plausible;
- `contradicts`: the source gives a meaningful reason the claim or recommendation may be wrong;
- `limits`: the source narrows applicability or identifies a caveat.

Prefer first-party documentation, standards, papers, official benchmarks, and current primary data.
For changing technical facts, record the publication or access date in `limitations` or the summary.
Use the source id in the final delegated report so coverage can be checked mechanically. A packet with
no contradictory source is not automatically invalid, but the final review must flag it.

If the web cannot settle a claim, preserve the uncertainty: add a `limits` source when useful and put
the unresolved question in the final report. Do not fill gaps with invented sources, unsupported
confidence, or a citation that was not actually inspected.
