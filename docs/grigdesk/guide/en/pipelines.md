# Starting and running pipelines

A pipeline performs a task along a published route: agents, verification commands and human decisions form one attempt.

While cards load, phone layouts reserve the header's space; full layouts reserve the graph too. Current-attempt data appears there after loading.

## Before you start

You need a prepared task, active project, available executors and published route. If a profile requires an environment, it must know how to prepare one. If an old layout is reported, perform [factory maintenance](data-and-backups.md) first; an empty new run does not replace the previous attempt.

## What to do

1. Open the task and launch form. Check project, route, triage result, working copies and proposed parameters.
2. Confirm launch and open Pipeline. Select the attempt card.
3. Follow the current stage: blue means working, green passed, yellow waiting for a person, red failure. Open a node by click, Enter or Space.
4. At a stop, read the stage document, check results and cause. Respond through the gate or stop analysis. An “executor environment refusal” means the agent proved the environment blocks the stage, such as a sandbox unable to write Git metadata, and the engine avoided futile retries. Change the stage executor on Executors or fix the environment, then return with Go here and an explanation.
5. For repairs, use the proposed transition or Go here with an explanation. Check which results will be recalculated. If the same environment failure persists after building and restarting GrigDesk, unpin the attempt using Rebind runtime in that stage dialog: the next run continues on the current server distribution with the updated tool.
6. Pause or stop using the standard button if needed. A normal stop is not a failure: there is no red “Pipeline interrupted” afterward, and Continue resumes the attempt. After fixing the cause, continue the existing attempt within displayed constraints.

After moving state, open the previous card, check documents and cursor, and use Continue. A directory change alone needs neither a new attempt nor recovery. Continuation may invoke a model and prevents going back after new writes. Memory support depends on the executor's own contract. Testing migration with temporary data does not verify the real executor; authorization and compatibility are checked separately.

## Stage executor, model and effort

Open the node's Executors tab. Choose an executor, available model and compatible effort. These are draft fields and start nothing. From profile for model and effort separately restores inheritance from current project settings. Fix incompatible pairs manually; the application explains the cause without choosing a replacement.

For a stage not yet started or already stopped, press Apply. The setting is saved only for this stage of the current run; resume a stopped run normally. The profile, other stages and new runs retain their own parameters.

On a working stage, Save for next launch leaves the current attempt using previous parameters. Restart with these parameters asks to confirm stopping and creates a new launch even if only effort changed for the same executor. Distinguish next-launch settings, the draft and actual journal parameters. Reloading or reopening keeps confirmed choices. After restart, the open dialog follows the new launch and retains unsaved draft fields, so further parameters can be applied there.

If the catalog changes, the application keeps the draft and shows the refusal cause; retry loading and choose an available pair. If restart was accepted but the new process failed to start, the message separately confirms the save and explains the failure. While the chosen executor's catalog is unavailable, fields and application are disabled; the saved local model and effort remain visible, without substituting the previous executor's models. An unavailable base project executor does not prevent opening a confirmed choice of another executor for the stage. With older engine versions, editing may be unavailable: history remains readable, and a new version is used for new runs without automatically replacing an existing one.

## Result

The card and documents show the actual stage and verification results. An agent finishing does not replace acceptance and delivery.

In a looping route, the lead assigns work to an executor and independently checks results. For an isolated project environment, the worktree and environment are prepared at attempt start and retained across loops. At a gate, a person can return findings to the lead; publication follows acceptance and the route's delivery step. The mandatory final verification command must succeed before acceptance.

## Limitations and recovery

After a write failure, Continue may restore an already verified result without rerunning the agent. If the result handed a decision to a person, open the indicated node: the question and comment remain, and another Continue does not answer for you. Use Go here with an explanation to rerun a stage.

If the route checks environment readiness, it may perform limited repair of its own services and retry acceptance. If repair is exhausted, read the cause and actions taken; pressing retry does not itself create a new budget. Old attempts keep their route until an explicit run change.

Executor access is pinned before launch. Pausing or restarting the server does not let you switch accounts mid-attempt; resuming uses the previous access. This includes fallback executors in the permitted chain. To add a new executor outside the pinned chain, pause the pipeline first, select the stage executor and continue. After completion, access can be switched in Settings again.

A saved graph without a live process does not prove execution. In a loop, the lead hands tasks to the executor and brings results to acceptance; reaching the loop ceiling or making no progress requires a decision. The task environment may be available only while stopped.

## Related articles

[Tasks](tasks.md) · [Gates](gates.md) · [Routes](routes.md) · [Environments](sandboxes.md) · [Data and backups](data-and-backups.md)
