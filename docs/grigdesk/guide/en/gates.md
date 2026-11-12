# Human decisions and stops

A gate is a scheduled decision about a plan, cause or result. Moving the cursor back and analyzing a failure have separate actions.

## Before you start

Open the current attempt and its problematic node. Read the document and summary of decisions the arbiter has already made.

## What to do

1. At a gate, choose Accept or Reject. After rejection, fill in what needs improvement.
2. Answer node questions individually: separate answers are linked to the relevant findings.
3. For Go here, explain why: the selected stage's agent receives that text.
4. On failure, open the Arbiter tab in the node dialog for stop analysis. Stage content stays on Result, where the stop cause and Go here are available without analysis. Questions and diagnostics do not restart the stage; a proposal's separate button or your own instruction starts repair.
5. Before applying, check the target and results to recalculate. If the decision was saved but launch failed, retry only launch.
6. While the arbiter analyzes a stop, Stop arbiter in the pipeline card or analysis header can stop it. Received messages remain; a separate button can repeat analysis. Continue run first stops a working arbiter, then starts the pipeline.

In the node dialog, open Journal and check the cause beside each launch attempt. Causes are recognized for Claude, Codex, DeepSeek, GLM and Kimi. Exhausted limits show “Quota exhausted” or the provider's explanation; GLM separately explains insufficient balance or plan allowance. The specific cause is also visible in stop analysis. Wait for quota recovery or select an available executor before retrying. Completed attempts receive explanations from their saved journal when available. Unknown refusals show the original provider message when it can be extracted. For a new refusal format, the journal shows the executor's last diagnostic message. If no cause was supplied, the interface says so and shows the exit code; an unavailable journal is identified separately. A diagnostic message does not mean the pipeline will automatically repeat completed work.

## Result

A person explicitly accepts the result or directs repair to the appropriate stage. The decision history stays with the attempt.

## Limitations and recovery

After a write failure, Continue may restore an already verified result without rerunning the agent. If the result handed a decision to a person, open the indicated node: the question and comment remain, and another Continue does not answer for you. Use Go here with an explanation to rerun the stage.

If a route checks environment readiness, it may perform limited repair of its own services and retry acceptance. If repair is exhausted, read the cause and actions taken; retrying does not create a new budget. Older attempts retain their route until a separate run change.

Text entered when accepting is not sent to the agent: leave qualifications in the task or request revision. Returning with text to a command node may be unavailable. Automatic arbiter analysis does not mean automatic continuation. In a loop, acceptance findings go to the lead.

## Related articles

[Pipelines](pipelines.md) · [Tasks](tasks.md) · [Routes](routes.md)

If an agent skips a check, the skipped comment is retained as the stop reason. A missing screenshot alone does not mean a report is missing.
