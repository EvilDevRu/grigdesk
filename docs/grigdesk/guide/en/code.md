# Code and Git

Code shows files, Git changes and commits in registered repositories.
Source and comparison viewing are read-only.

## Before you begin

Enable the tool and register project paths. Git actions require an available repository on the server.

## What to do

1. Open Code and choose project, repository and working copy.
2. In Files, select a document or search paths/content with at least two characters. Results open the matching line.
3. In Changes, compare index against HEAD and working tree against index. A file can appear in both groups.
   Choose a file or Overview.
4. In Commits, select a range; Shift adds an interval. Include current adds working changes only to a range ending at HEAD.
   Entire branch needs an available base.
5. Switch side-by-side/stacked above the editor. Diff view contains whitespace, context and wrapping.
   F7/Shift+F7 move through blocks and then neighbouring files in the group.
6. Use Reviewed, progress and next-unreviewed navigation. Code actions offers block selection, feedback,
   explanation and partial staging; Agent feedback opens separately. Narrow layouts use icons with tooltips.
   Stage, revert and commit only within the displayed scope after reading warnings and confirmations.
7. Ask agent creates a separate editable draft with files/changes without sending it. Link copies path and available position.

Search paths above the change tree; the funnel opens status filters.
Tree actions collapses/expands directories or reveals the open file. Filtering shows results and clear controls.
Ctrl/Meta, Shift or row-selection buttons select multiple files and reveal an action bar with count and clear selection.

## Test another branch on the main environment

1. Select the repository's main working copy and click the branch button.
2. Configure stop, build, background start and readiness commands once in Project launch commands.
   Preparation and application URL are optional. Bash runs them in this same folder.
   Start must launch a background process and exit; readiness must wait and return 0.
   Saving commands does not start the environment. The default return branch is `dev`.
3. Find a local or remote branch. The list uses known Git refs; fetch in Changes before selecting a new remote branch.
4. Choose Switch and build and confirm folder, branch and commit. The environment stops, this folder switches,
   then saved commands run, with up to 20 minutes per stage.
5. Watch stage and log. Actual branch/commit are separate from the last job. A successful readiness check offers
   Open application if a URL is configured.
6. Return to dev switches back, rebuilds and starts with the same commands.
   A configured alternative return branch appears in the button label.

Only one branch occupies the main folder; this creates no extra copy, ports or data.
For multiple repositories, only the selected one switches.
Modified, staged or untracked files, unfinished Git transitions or an active agent in the folder block launch.
Branches checked out in another working copy are unavailable.
A remote branch creates a local tracking branch; choose an existing local branch explicitly.
Failure stops later stages, potentially leaving the application stopped after a build failure.
There is no automatic rollback; fix and retry or return to dev.
Closing the dialog does not stop its job; reopening shows the result.
Switching GrigDesk itself loses connection until restart and requires user systemd availability before stopping.
An older branch may lack this management screen.

## Prepare and push a commit

1. Stage the required files with `+`; `−` unstages them. Check directory and partial selections first.
2. Enter a message below. Suggested messages use the staged diff and do not commit automatically.
3. Commit the prepared index. Unstaged files are not added automatically.
4. The circular remote-check arrow fetches without changing working files.
   Pull updates the current branch and files only by fast-forward, requiring a clean copy and configured upstream.
   Divergence refuses with a reason; no rebase, merge commit or automatic stash occurs. A toast confirms results.
5. Push uses no force and can publish a branch without upstream. You may close Code while it continues;
   a dismissible toast reports success/failure. Another Git command in that panel waits for completion.
6. An unpublished local HEAD supports amend and soft reset with confirmation. Check their scope and meaning first.

Reverting a tracked change restores from the index while preserving its staged portion.
Deleting a new file is separate and irreversible; group revert does not delete new files.
File history and blame are available from file actions; viewing versions does not resolve conflicts.

## Result

Changes are reviewed with explicit comparison sides. File and range selection survive snapshot refresh.

## Limits and recovery

Conflicts show our version and working file; mark resolved after repair.
Commit ranges cannot be staged/unstaged. Reload stale snapshots.
Unknown file links remain text. Without upstream, the whole-main-branch overview is unavailable.

## Related articles

[Projects](projects.md) · [Working folder](chat-workdir.md) · [Conversations](chats.md)
