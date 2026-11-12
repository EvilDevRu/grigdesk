# Code and Git

The Code plugin shows files, Git changes and commits in registered repositories. Source and comparison viewing is read-only.

## Before you start

Enable the tool and register project paths. Git actions need an accessible repository on the server.

## What to do

1. Open Code and choose a project, repository and working copy.
2. In Files, select a document or search paths/content with at least two characters. Click a result to open its line.
3. In Changes, compare index with HEAD and working tree with index; a file may appear in both groups. Choose a file or Overview.
4. In Commits, select a range; Shift includes the interval. “+ current” includes working changes only for a range ending at HEAD. Entire branch requires an available base.
5. Switch side-by-side/stacked view with the button above code; whitespace, context and wrapping are under Comparison view. F7/Shift+F7 move through hunks, then neighboring files in the group.
6. Review using Viewed, progress and jump to unviewed below the header. Code actions offers hunk selection, findings, explanation and partial staging. Agent findings opens separately. Narrow panels replace action labels with tooltip icons; layout settings remain under Comparison view. Stage, rollback and commit only within the displayed scope, respecting warnings and confirmations.
7. Ask agent creates a separate editable draft with the file/changes without sending it. Link copies the path and available position.

Search paths above the changes tree; the funnel opens a status filter. Tree actions beside search collapses/expands directories or reveals the open file. Result count and clear appear while filtering. Select multiple files with Ctrl/Meta, Shift or the row-selection button to show an action bar with selected count and clear selection.

## Test another branch on the main environment

1. Select the required repository's main working copy. Press the current branch button in the header.
2. In Project launch commands, configure stop, build, background start and readiness check once. Preparation and application URL are optional. Commands use Bash in this directory; start must launch a background process and return, and the check must wait for readiness and exit 0. Saving commands does not start the environment. The default return branch is `dev`.
3. Find a local or remote branch. The list shows Git branches already known; before selecting a new remote branch, update refs with the circular fetch arrow in Changes.
4. Press Switch and build and check directory, branch and commit in confirmation. The environment stops, this same directory switches branches, then saved commands run. Each stage has up to 20 minutes.
5. Follow the stage and journal. Actual directory branch and commit appear separately from the last job. After successful checking, Open application is available if a URL is configured.
6. After checking, press Return to dev: the directory switches back and the environment rebuilds and starts with the same commands. If settings change the return branch, the button names that branch.

One main directory has one active branch. No new copy, separate ports or data are created. For multi-repository projects, only the selected repository switches. Unsaved, staged or new files, an unfinished Git transition, or an agent in the directory block launch. A branch occupied by another working copy is unavailable too. Selecting a remote branch creates a local tracking branch; if one already exists, select it explicitly.

An error stops later stages. Read the journal and check the current branch: a failed build may leave the application stopped. There is no automatic rollback; fix the cause and retry or return to `dev`. Closing the dialog does not stop the job; reopening shows its result. Switching GrigDesk itself disconnects until it starts; this requires available user systemd, otherwise the server refuses before stopping. Older GrigDesk branches may lack this management screen.

## Prepare and push a commit

1. In Changes, stage required files with `+`. `−` returns a staged file to the working group. Check the contents first for directories and partial selections.
2. Write a message in the bottom form. Title generation proposes text from the staged diff without committing.
3. Commit: it includes only the prepared index, without automatic file addition.
4. In the bottom row, Check remote repository (circular arrow) fetches and updates counters without changing working files. Pull changes (down arrow) updates the current branch and files only through fast-forward. Pull requires a clean copy and configured remote upstream. Diverged history refuses with an explanation; there is no rebase, merge commit or automatic stash. Success or no new changes produces a toast.
5. The up arrow pushes without force and can publish a branch without upstream. You can close Code after pressing it; sending continues and success or error appears as a dismissible shared toast. Another Git command in that panel is unavailable until completion.
6. For an unpublished local HEAD, amend and soft reset are available with confirmation. Check the action's scope and meaning first.

Revert on a tracked change restores the file to the index and retains staged content. Deleting a new file is a separate irreversible action. Group revert does not delete new files. File history and line authorship are available from file actions; viewing versions does not automatically resolve conflicts.

## Result

Changes are reviewed with explicitly named comparison sides. File and range selections survive snapshot refresh.

## Limitations and recovery

A conflict shows our version and the working file; after fixing it, mark it resolved. Commit ranges cannot be staged/unstaged. Reload changes for a stale snapshot. Unknown file links stay as text. Missing upstream makes the whole-main-branch overview unavailable.

## Related articles

[Projects](projects.md) · [Working directory](chat-workdir.md) · [Conversations](chats.md)
