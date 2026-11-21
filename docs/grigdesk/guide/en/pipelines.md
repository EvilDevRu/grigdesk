# Starting and running pipelines

A pipeline runs a task along a published route. Agents, verification commands and human decisions form one attempt.
Loading keeps header space on phones and diagram space in the full layout until current attempts arrive.

## Before you begin

Prepare a task, active project, available executors and published route.
If the profile requires an environment, it must be able to prepare one.
An old-layout warning requires [factory maintenance](data-and-backups.md);
an empty new run does not replace an existing attempt.

## What to do

If a stopped attempt is pinned to a retired factory, choose Rebind runtime and then Resume.
The Go factory uses the same attempt, route and accepted results.

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

A short route can reach a gate or show its result immediately. The card opens
the recorded state of the same attempt.

If Git access stops publication, check whether the agent requested the executor's supported permission
and the response. A first filesystem refusal alone does not prove publication impossible.
Supported modes request access for the exact action; an actual refusal remains in the report.
For an older route that immediately hands work to a human, use Go here on publication alone with new instructions.
Accepted stages need not rerun; catalog updates do not rewrite the attempt's pinned instructions.
In SHIP, use `tracker` or `grigdesk-ctl tracker` with the task's explicit source board.
Verify and reuse existing commits and PRs rather than recreating them.

After migration, open the original card, verify documents and cursor and Resume it.
A folder change alone needs neither a new attempt nor restoration.
Resuming may call a model and closes the back option after new writes.
Executor memory support follows its own contract; temporary-data migration checks do not prove real authentication
or executor compatibility.

## Creation without automatic start

To assign executors per node before work begins, turn off "Automatically start the
pipeline on creation" in [settings](settings.md) (Automation → Launch). The "to
pipeline" button then creates the pipeline without running any node, including scouting:

1. Confirm the launch in the task card. "Created, awaiting start" means the attempt
   exists; while the stand provisions, the card shows "creating".
2. Open Pipeline: the card is "awaiting start", the route graph is visible, no node
   has run yet. The stand and slot stay reserved until start.
3. Open the nodes and assign executors, models and effort on the Executors tab.
   Choices save immediately and apply from the first node after start.
4. Press "▶ start run" on the card and confirm. The pipeline runs scouting and
   follows the route with the assigned parameters.

If scouting pauses with a question, open the SCOUT node, save your answer, and select Resume.
Once scouting succeeds, Resume uses the saved result.

When an executor supply incompatibility is confirmed, Resume rebinds once to the
current GrigDesk runtime and preserves the attempt's progress. Ordinary executor
unavailability keeps the existing runtime pin.

The toggle affects only the manual launch from the task card: Telegram rule
auto-launches and bulk start work as before. The enabled toggle (default) keeps the
ordinary immediate launch.

## Stage executor, model and effort

The editor is available when the runtime pinned to the attempt supports stage settings.
When a stopped attempt is rebound to Go, resuming uses the previously saved
settings for that stage.

On Linux, the node stops advancing if its stand control channel fails to close.
The launch log shows the profile hook error.

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
The editor opens when the pinned engine supports saving settings and restarting from the card.
The Go factory in the Linux x64 package supports both actions. Settings saved
during a launch take effect the next time that stage runs.
History remains available when the editor is unavailable.

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

On macOS, a profile with a control channel must declare a compatible interface.
A shared environment also declares its recovery mode. The error identifies the
missing interface or mode. If stop cleanup is still pending, resolve the reported
issue and use Stop again on the same attempt.

In a Linux Go test installation, Resume can finish restoring temporary files after an
interruption. After a confirmed Stop and cleanup, Resume starts at INSTRUMENT. If the task
reports a conflict, review the changes in the checkout. If an abrupt interruption leaves
the stage outcome unconfirmed, use Go here on the INSTRUMENT stage.

After a write failure, Resume can restore a verified result without rerunning the agent.
If it requires a human decision, open the indicated node: its question/comment remain and Resume does not answer for you.
Use Go here to rerun a stage. A route's readiness check may repair its own services within a limited budget
and retry acceptance. Repeated clicks do not replenish that budget. Old attempts retain their route until explicitly changed.

Executor access is pinned before launch. Pauses and server restarts do not permit switching accounts mid-attempt,
including fallback executors. To add an executor outside the pinned chain, pause, select the stage executor and resume.
After completion, profile switching is available again.
A saved diagram without a live process does not prove execution.
Reaching the round ceiling or making no progress requires a decision. Task environments may be available only during a stop.

## Control through an agent

Ask the agent to perform the required action. It uses pipeline through your running GrigDesk;
a web development server is not required. pipeline list shows attempts, status shows details,
state reads the current attempt identity, graph reads the workflow, and doc reads a stage document.

For a launch, the agent reads `pipeline source <board>` and
`pipeline launch-options <task> <profile> <source>`, presents the selected route, and sends the
agreed JSON to `pipeline launch <task>`. Both source and route are explicit.

Stop, resume, return and gate commands use the identity that was read before the decision.
Before the main cursor exists, `pipeline prelude-state <task>` provides expectedPrelude for
stop/resume; this also resumes the same attempt after a bootstrap answer.
If state changes, the command fails and the agent reports the current state before another action.
runner-options provides the model and effort catalog. runner-set either saves the next-run
selection or explicitly restarts the stage with the selected parameters.

The arbiter has separate commands for reading, discussion, question answers, diagnosis,
applying a proposal and retrying a committed decision's resume. Discussion and diagnosis
do not authorize a workflow transition. Gate decisions and applying proposals require
the person's explicit instruction.

`pipeline wait <task> <attempt> [timeoutMs] [intervalMs]` observes one attempt.
Its result distinguishes a terminal outcome, human input, a manual stop and a timeout.
An attempt closed before the main cursor exists also returns its trusted terminal outcome.
If a decision is saved but resume fails, exit code 3 keeps the result in stdout:
retry only resume. Check state before repeating an operation after a connection failure.

A Qwen stop includes the failure reported by its wrapper. Check that reason before retrying
the stage; a successful later run clears the previous error.

## Check a run after switching installations

Check the project profile in a separate installation. Open an existing task at its
approval gate, close the task panel, and reopen it. Check the stage and journal, record
the decision, and continue. The journal should show one result for the completed check.
Once the route finishes, its card shows that it is done.

To check DeepSeek on a Linux build with the Go engine, choose a stage that allows
browser access. After you continue, the runner can use the GrigDesk browser tool
while that stage is active.

## Related articles

[Qwen Code](qwen.md) · [Tasks](tasks.md) · [Gates](gates.md) · [Routes](routes.md) · [Environments](sandboxes.md) · [Backups](data-and-backups.md)
