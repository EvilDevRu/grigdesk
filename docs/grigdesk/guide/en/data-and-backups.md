# Data and backups

The program, server data and client window settings are stored separately. A backup must cover every location you use.

## Before you start

Identify the selected machine and its actual data directory. The default is `~/.grigdesk`; explicit settings may choose other paths.

## What to do

1. Finish agent turns, recordings, installations and jobs. Use the owner's normal controls to stop processes using the data consistently.
2. Copy the entire data directory with permissions: machine settings, history and attachments, device bindings, incoming archives, plugins and their state, models and artifacts.
3. Separately save working repositories, executor homes, factory state and the route directory. These may be outside GrigDesk's directory. Save window settings and selected server too if moving the client.
4. Check that the backup is readable and restrict access: it contains keys and conversations.
5. Restore while processes are stopped. Restore consistent directories and permissions, then start one server instance and check the machine and history.

## Result

You have a consistent copy of working data, rather than just program binaries.

## Cleaning old artifacts

1. Back up artifacts you need. Cleanup is irreversible and does not check conversation links: images in old replies may disappear after their files are removed.
2. Run `grigdesk-ctl artifacts-cleanup --dry-run`. Check the displayed root, every directory, its size and the total. Explicit `GRIGDESK_ARTIFACTS_DIR` chooses another directory. An initial scan of a large directory may take minutes; Ctrl+C safely interrupts dry-run. In the menu, Ctrl+C also stops a preliminary scan still in progress.
3. Run `grigdesk-ctl artifacts-cleanup` when the list is right. Set another age with `--older-than 12h` or `--older-than 14d`: whole minutes `m`, hours `h` and days `d` are accepted; the default is 7 days. `--keep-generations 3` sets how many recent test-cache generations to keep. `--json` provides a machine-readable report.
4. Alternatively, choose “Developer → Artifact cleanup” in any installation's terminal menu. It first shows the list; “Cancel” is selected by default. Only an explicit “Delete” starts removal with rechecking.
5. Check the report. Young and busy directories remain, along with the main Node cache components. During removal, new operations using directory locks wait; another cleanup skips directories if the barrier is busy. You can repeat the command afterward. Reported bytes estimate deleted files and may differ from newly free disk space. On an error, fix the cause and retry; other directories may already have been removed. Ctrl+C ends cleanup with code 130, SIGTERM with 143. Removal of one directory already in progress may finish; later directories are left alone, and deleted files are not restored. The report retains completed work; JSON marks cancellation with `interrupted: true`.

The server does not automatically clean other topics. DeepSeek tests clean only their own known old results. Restore lost user files from backup; recreate test builds through normal preparation.

## Limitations and recovery

One directory cannot promise a complete backup: the factory and external executors have their own homes. Server generation caches do not replace history. Do not remove live processes' locks. Old absolute attachment links may require the previous location.

## Related articles

[Updates](updates.md) · [Working directory](chat-workdir.md) · [Connections](connections.md) · [Pipelines](pipelines.md) · [Routes](routes.md)
