# Starting and running pipelines

A pipeline runs a task along a published route. Agents, verification commands and human decisions form one attempt.
Loading keeps header space on phones and diagram space in the full layout until current attempts arrive.

## Before you begin

Prepare a task, active project, available executors and published route.
If the profile requires an environment, it must be able to prepare one.
An old-layout warning requires [factory maintenance](data-and-backups.md);
an empty new run does not replace an existing attempt.

## What to do

1. Open the launch form and check project, route, triage, working copies and proposed settings.
2. Confirm and open Pipelines. Choose the attempt card.
3. Follow the current stage: blue runs, green passed, yellow awaits a human, red failed.
   Open a node by click, Enter or Space.
4. At a stop, read its document, checks and reason. Respond through the gate or stop analysis.
   Executor-environment refusal means the agent proved the environment blocks the stage, such as a sandbox
   unable to write Git metadata, and the engine avoided futile retries.
   Change executor on the Executors tab or repair the environment, then use Go here with an explanation.
5. For rework, use the offered transition or Go here and check which results will be recalculated.
   If the same environment refusal persists after rebuilding and restarting GrigDesk, Rebind runtime in the stage
   dialog lets the next execution continue this attempt on the current server distribution.
6. Pause or stop with normal controls. A deliberate stop is not a failure and does not show a red interrupted-pipeline
   error. After fixing a problem, Resume the same attempt while observing its stated limits.

If Git access stops publication, check whether the agent requested the executor's supported permission
and the response. A first filesystem refusal alone does not prove publication impossible.
Supported modes request access for the exact action; an actual refusal remains in the report.
For an older route that immediately hands work to a human, use Go here on publication alone with new instructions.
Accepted stages need not rerun; catalog updates do not rewrite the attempt's pinned instructions.
If SHIP failed because `b24` is absent, use `tracker` or `grigdesk-ctl tracker` with the task's explicit source board.
Verify and reuse existing commits and PRs rather than recreating them.

After migration, open the original card, verify documents and cursor and Resume it.
A folder change alone needs neither a new attempt nor restoration.
Resuming may call a model and closes the back option after new writes.
Executor memory support follows its own contract; temporary-data migration checks do not prove real authentication
or executor compatibility.

## Stage executor, model and effort

Open a node's Executors tab. Select an executor, available model and compatible effort.
Choices save immediately without Apply. From profile, separately for model and effort, restores current project
inheritance. Invalid pairs require manual correction; the app explains why without choosing a replacement.
Field-label tooltips show the setting's source.
You may close the dialog or open another node while saving continues.
Reopening shows the choice and pending status; failures name the original task and stage.

Settings apply only to that stage of this run. Resume a stopped run normally.
An unstarted node immediately shows the saved executor/model. Profiles, other stages and new runs retain their settings.
During execution, new choices apply to the next launch. Restart with these settings asks to stop the current launch
and creates a new one, including for an effort-only change.
Fields and the next-launch summary show saved settings; the header and log show actual running settings.
Confirmed choices survive reload. After restart, an open dialog follows the new launch and preserves unsaved input
so you can apply subsequent settings there.

Catalog changes preserve drafts and show the reason. Reload and choose an available pair.
Use Retry save after a write failure. If restart was accepted but process startup failed, the message distinguishes
saved settings from startup failure. While the selected executor catalog is unavailable, fields and application
are blocked; the saved local model/effort remain visible without another executor's models being substituted.
An unavailable project default does not block opening a confirmed override using another executor.
Older engines may lack the editor; history stays readable and new engines apply to new runs without silently replacing old ones.

## Result

Cards and documents show actual progress and verification. An agent finishing is not acceptance or delivery.
In loop routes, a lead assigns work and independently checks results.
Isolated worktrees and environments are prepared at attempt start and retained between rounds.
Human gate feedback returns to the lead; publication follows acceptance and route-defined delivery.
Required final verification commands must succeed before acceptance.

## Limits and recovery

An isolated test environment has none of the main installation's projects or profiles.
If no pipeline-capable projects are available, prepare a separate test project, profile and published route first.
Then return using Go here with an explanation; retrying without preparation repeats the refusal.
If CLI preparation failed before attempt creation, the message identifies executor, copy and reason.
Fix that installation/settings and relaunch the same task without restarting GrigDesk,
but only once it is confirmed the engine received no launch and created no run artifacts.
Once handed to the engine, wait for the attempt and Resume it normally.

After a write failure, Resume can restore a verified result without rerunning the agent.
If it requires a human decision, open the indicated node: its question/comment remain and Resume does not answer for you.
Use Go here to rerun a stage. A route's readiness check may repair its own services within a limited budget
and retry acceptance. Repeated clicks do not replenish that budget. Old attempts retain their route until explicitly changed.

Executor access is pinned before launch. Pauses and server restarts do not permit switching accounts mid-attempt,
including fallback executors. To add an executor outside the pinned chain, pause, select the stage executor and resume.
After completion, profile switching is available again.
A saved diagram without a live process does not prove execution.
Reaching the round ceiling or making no progress requires a decision. Task environments may be available only during a stop.

## Related articles

[Qwen Code](qwen.md) · [Tasks](tasks.md) · [Gates](gates.md) · [Routes](routes.md) · [Environments](sandboxes.md) · [Backups](data-and-backups.md)
