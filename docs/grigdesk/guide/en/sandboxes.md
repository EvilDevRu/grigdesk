# Sandboxes and test environments

This section lists environments and manages their lifecycle through the selected profile's scripts.

## Before you begin

The profile must declare preparation and removal. Its scripts create containers, schemas and working copies;
GrigDesk coordinates launch and displays results.

## What to do

1. Open Sandboxes, choose an environment or new preparation and check project/profile and number.
2. Confirm creation and follow the step and log. Closing the window does not cancel detached work.
3. Open the displayed website/API links after readiness. Expand Code and working folders for branches and paths.
4. For profile-defined extra runs, choose an action, fill arguments and review confirmation.
   The job log contains result and output tail.
5. Open removal controls. Tear down preserves uncommitted copies according to profile rules;
   the explicit including changes option passes forced removal and patch preservation to its script.

Narrow layouts use List / Environment tabs below the header and keep input when switching.
Refresh precedes Create environment.

## Result

The log shows the actual profile action result. Successful removal releases the slot reservation without deleting branches.

## Limits and recovery

Remove pipeline environments from their task card.
For manual environments with no known profile, select one explicitly before teardown.
Recording or active runs may mark an environment busy.
Do not remove locks or retry unknown outcomes before checking the process and log.

## Related articles

[Pipelines](pipelines.md) · [Docker](docker.md) · [Presentations](showcase.md)
