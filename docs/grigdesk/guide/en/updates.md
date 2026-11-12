# Updates and rollback

Release means stable X.Y.Z versions; dev means explicitly selected experimental X.Y.Z-dev.N versions. Changing channels does not silently permit downgrading. Network and signature errors are shown separately from “no updates”.

## Before you start

A verified published release and trusted key are required. The owner publishes manually; commits and tags alone do not trigger publication. Actual builds undergo separate acceptance before user publication.

If the owner released a version while explicitly skipping the full CI suite, its update description says so. Signature, integrity and built-binary startup checks still apply; the user decides whether to install it.

## Application

1. A yellow dot beside the GrigDesk mark means an update is available. Click the mark or open Updates in Settings: both open the same dialog with versions, channel, components and description. Hover or focus shows a tooltip; Enter or Space opens it from the keyboard.
2. “Check for updates” contacts the website independently of the local server.
3. “Update” downloads and verifies prepared components. Percentages refer to downloaded bytes; verification and preparation appear as stages.
4. Closing the dialog or choosing “Later” keeps the job until you apply it with the button or close the window.
5. “Apply and restart” displays current activity. Turns may be interrupted; pipelines receive Stop and can be continued. Work is not stopped before consent.
6. Closing a window with a prepared update counts as confirmation: it applies on exit without a second update dialog. If chats and pipelines are stopped, the stop dialog warns that the update will apply and the application will restart. Updating takes control before ordinary server shutdown; forced shutdown is not successful preparation for replacement. If exit has already begun, an update prepared too late waits for the next application. Termination signals and startup errors, including closing the splash screen, do not apply updates.
7. A local application updates its window and server as one release. A remote profile updates only the window; the selected machine and its trusted certificate remain.

After a confirmed restart, a separate process continues updating: closing the old window at this stage does not require reinstalling. Failure to access process state remains an update error; fix its cause first and continue the previous job.

## Server without a window

`grigdesk-ctl` in a TTY opens a menu showing the version, channel and background check result. Without a TTY, an empty invocation prints help. Direct commands:

- `grigdesk-ctl server check-updates [--json]` — check the website;
- `grigdesk-ctl server update-status [--json]` — read installation and journal without a server;
- `grigdesk-ctl server update [--json]` — prepare a built server release;
- `grigdesk-ctl server resume-update [--json]` — continue the previous job;
- `grigdesk-ctl server resume-update --rollback` — restore the previous release if the new one cannot start with real data (applied_not_started with no other recovery);
- `grigdesk-ctl server update-channel release|dev` — explicitly choose a channel without an active job.

A TTY offers application after preparation; without a TTY, preparation leaves the job ready. Explicit `--restart` on update/resume-update confirms application and the consequences of stopping work. A stopped server remains stopped with applied_not_started; start it separately with `grigdesk-ctl server start --wait`. Downloading does not start the server. A local pair directs you to the application and cannot be half-updated by a server command. Successful updating frees its archives and unreachable generations; the journal and data remain, and the previous generation is retained for rollback.

## Checking the result and recovery

Running describes the live process; installed describes disk state. Completed confirms the required components started; applied_not_started does not yet mean the new server is running. A failure of one component is not reported as success of the pair: the journal and previous generations remain. The application's Continue button or CLI resume-update resumes the previous target. If a new generation cannot start with real data, `resume-update --rollback` restores the previous release with explicit consent. The local server may be stopped or running from anywhere: a stopped server is recognized by a refused port and needs no CLI token. Actual component probe output is in the installation's job journal: `update/<id>/probe-desktop.log` and `probe-server.log`. Startup noise, such as Electron dbus messages, is visible there but is not itself a failure.

After an abnormal exit, continuation automatically releases the lock of a process proven to have ended and immediately retries acquisition. Manual removal is unnecessary. If a live process owns the directory, or its state cannot be checked, the operation refuses: wait for the other update operation to finish and retry.

On a signature error, do not bypass verification or delete data or saved generations. Read the state and fix the reported cause first. After switching local/remote, return to the appropriate profile for the confirmed job. A remote server is updated separately with its CLI on that machine; updating the window does not restart it. Source installations keep the previous Git workflow; Android updates separately.

## Related articles

[Installation](installation.md) · [Backup](data-and-backups.md) · [Diagnostics](troubleshooting.md)
