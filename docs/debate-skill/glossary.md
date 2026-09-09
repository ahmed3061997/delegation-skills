# debate-skill working glossary

Status: provisional definitions for the design interview.

| Term | Meaning |
| --- | --- |
| Orchestrator | The assistant running the skill, gathering context, reviewing claims, researching evidence, and reporting to the user. |
| Agent CLI | A locally installed command-line agent that receives a delegated brief. |
| Catalog | JSON describing discovered CLIs and observed model and effort availability. Installed and dispatchable are separate properties. |
| Selection | The user's chosen agent, model, and effort for the debate. |
| Debate | Technical evaluation of a decision through arguments and objections. Whether it involves multiple opposing participants remains open. |
| Reference packet | Relevant codebase excerpts and locations supplied as context for the decision. |
| Brief | Instructions and context sent to a delegated agent for one pass. |
| Pass | One delegated analysis and its resulting report. |
| Provisional verdict | The initial assessment before web evidence is gathered and evaluated. |
| Evidence packet | Web sources and their relationship to specific claims, including support, contradiction, and limitations. |
| Final recommendation | The proposed decision after evidence review; it does not itself authorize implementation. |
| Run status | Whether the delegated process completed, failed, or was interrupted; distinct from the quality of its conclusion. |
