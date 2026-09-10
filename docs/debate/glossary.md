# debate glossary

Status: accepted definitions for the implemented workflow.

| Term | Meaning |
| --- | --- |
| Orchestrator | The assistant running the skill, gathering context, reviewing claims, researching evidence, and reporting to the user. |
| Agent CLI | A locally installed command-line agent that receives a delegated brief. |
| Catalog | JSON describing discovered CLIs and observed model and effort availability. Installed and dispatchable are separate properties. |
| Selection | The user's chosen agent, model, and effort for the debate. |
| Debate | Technical evaluation of a decision through one delegated participant's position, claims, objections, alternatives, and uncertainty. It is not necessarily multiple agents. |
| Reference packet | Relevant codebase excerpts and locations supplied as context for the decision. |
| Brief | Instructions and context sent to a delegated agent for one pass. |
| Pass | One delegated analysis and its resulting report. |
| Provisional verdict | The initial assessment before web evidence is gathered and evaluated. |
| Evidence packet | Web sources and their relationship to specific claims, including support, contradiction, and limitations. |
| Run status | Whether the delegated process completed, failed, or was interrupted; distinct from the quality of its conclusion. |
| Evidence source | An inspected web source mapped to one or more claims as supporting, contradictory, or limiting evidence. |
| Semantic review | The orchestrator's completeness and argument-quality check over a delegated report; it is distinct from the process review in delegate. |
| Final recommendation | The orchestrator-owned decision record after considering both delegated passes and the evidence packet; it does not itself authorize implementation. |
