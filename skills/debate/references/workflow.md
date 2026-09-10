# Debate workflow

## Roles

The orchestrator owns the question, reference selection, web research, semantic judgment, and final
report. The delegated agent is a read-only participant whose job is to expose reasoning, objections,
alternatives, and uncertainty. It does not receive chat history, so every pass must carry its context.

## Two-pass contract

The initial pass answers the question from the local reference packet and produces a provisional
position. The orchestrator checks whether the argument is coherent, whether objections are serious,
and whether alternatives were considered. A process exit of zero is only a transport fact.

The final pass receives the same local context plus a web evidence packet and the provisional review.
It must try to disconfirm the provisional verdict. The orchestrator then decides whether the evidence
supports a recommendation, leaves the question unresolved, or calls for a narrowly scoped follow-up
outside this skill.

The default is two passes because it bounds cost and makes the stopping condition clear. A failed or
incomplete pass is reported as failed or unverified; it is not silently retried. The user may start a
new debate explicitly.

## Selection and permissions

Use `delegate`'s catalog and selection helpers. Preserve the selected agent, model, and effort
between passes. If a session id is returned, continuation is allowed because it keeps the participant
and context stable; the dispatcher still passes the read-only profile on the resumed turn. If the
adapter cannot continue, start the final pass as a fresh read-only run with the same selection.

Do not use a write-capable profile for debate. No debate result itself authorizes implementation,
external communication, or a change to the working tree.

## Reporting

Report at least:

- the recommendation or explicit unresolved state;
- the strongest reason in favor and strongest reason against;
- which local references and evidence sources mattered;
- confidence and what could change it;
- process status, including missing output or failed checks.

Do not call the result “approved,” “proven,” or “verified” merely because a child process completed.
