# Human decisions and stops

A gate is a planned decision about a plan, reason or result.
Cursor returns and failure analysis are separate actions.

## Before you begin

Open the current attempt and affected node. Read its document and decisions already made by the arbiter.

## What to do

1. Accept or Reject at the gate. Rejection requires describing what needs improvement.
2. Answer node questions individually so each response is tied to its finding.
3. Explain a Go here return; the selected stage's agent receives that text.
4. For a failure, open Arbiter in the node dialog for stop analysis.
   Result keeps the stage content, stop reason and Go here without analysis.
   Questions and diagnostics do not restart a stage; use a proposal's separate action or your own instruction.
5. Before applying, check the target and results that will be recalculated.
   If a decision saved but launch failed, retry only launch.
6. Stop arbiter is available in the pipeline card or analysis header during analysis.
   Existing messages remain and analysis can be retried separately.
   Resume run first stops an active arbiter and then starts the pipeline.

The node Log shows a reason for each launch. Claude, Codex, DeepSeek, GLM and Kimi support reason recognition.
Quota failures show an exhausted-quota message or provider explanation; GLM distinguishes insufficient balance or package.
The same reason appears in stop analysis. Wait for quota recovery or select an available executor before retrying.
Completed attempts receive explanations from saved logs when available.
Unknown failures show the original provider message when extractable.
For new failure formats, the log shows the executor's last diagnostic message.
Missing reasons explicitly say so and show an exit code; unavailable logs are marked separately.
A diagnostic message does not mean completed work will automatically repeat.

## Result

A human explicitly accepts the result or sends rework to the required stage.
Decision history stays with the attempt.

## Limits and recovery

Resume may restore an already verified result after write failure without rerunning the agent.
Human questions and comments remain; Resume does not answer them.
Go here with an explanation reruns a stage.
Readiness repair, when provided by the route, has a limited budget; repeated clicks do not reset it.
Old attempts keep their own route until an explicit change.
Text entered with acceptance is not sent to the agent: record caveats in the task or request rework.
Returning with text to a command node may be impossible. Automatic analysis does not mean automatic continuation.
In loops, acceptance feedback goes to the lead.
If an agent skipped verification, its skipped comment remains as the stop reason.
A missing screenshot alone does not mean there is no report.

## Related articles

[Pipelines](pipelines.md) · [Tasks](tasks.md) · [Routes](routes.md)
