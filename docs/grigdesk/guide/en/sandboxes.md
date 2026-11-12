# Sandboxes and environments

This section shows existing environments and manages their lifecycle through the selected profile's scripts.

## Before you start

The profile must declare environment preparation and removal. It creates containers, schemas and working copies; GrigDesk coordinates launch and displays the result.

## What to do

1. Open Sandboxes, choose an environment or preparation of a new one, and check project/profile and number.
2. Confirm setup. Follow the current step and journal; closing the dialog does not cancel a detached process.
3. Once ready, open the website/API through the displayed links. Expand Code and working directories for branches and paths.
4. If the profile declares additional runs, choose an action, supply arguments and read confirmation. The result and output tail are in the job journal.
5. For removal, open the corresponding section. Tear down environment keeps an uncommitted working copy according to profile rules; “including changes” explicitly passes forced mode and patch preservation to the profile script.

In narrow panels, compact List / Environment tabs sit below the header and preserve input when switching. Refresh precedes Set up environment.

## Result

The journal shows the actual profile-action outcome; successful teardown releases the reserved slot. Branches are not deleted.

## Limitations and recovery

Remove pipeline environments through the task card. For a manual environment without a known profile, explicitly choose a profile before teardown. An active presentation recording or run may block teardown as busy. Do not remove locks or repeat operations with unknown outcomes without checking process and journal.

## Related articles

[Pipelines](pipelines.md) · [Docker](docker.md) · [Presentations](showcase.md)
