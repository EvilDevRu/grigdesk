# Updates and rollback

Release contains stable X.Y.Z versions; dev contains explicitly selected X.Y.Z-dev.N previews.
Changing channels does not silently permit downgrading. Network and signature errors are shown
separately from “no updates available”.

## Before you begin

Updates need a verified published release and a trusted key. The owner publishes manually;
commits and tags alone do not publish. Finished binaries undergo separate acceptance checks.
If the owner explicitly skipped the full CI suite, the update description says so.
Signature, integrity and binary startup checks still run; you decide whether to apply that release.

## Application

1. A yellow dot on the GrigDesk mark means an update is available. Click it or open updates in settings
   for the same dialog with versions, channel, components and release notes. Hover or focus shows a tooltip;
   Enter or Space activates the mark.
2. “Check for updates” contacts the website independently of the local server.
3. “Update” downloads and verifies prepared components. Percentages measure downloaded bytes;
   verification and preparation appear as stages.
4. Closing the dialog or choosing “Later” keeps the job ready for explicit application or window exit.
5. “Apply and restart” shows current activity. Agent turns may be interrupted; pipelines receive Stop
   and can be resumed. Work continues until you confirm.
6. Closing the window with a ready update confirms application without another update dialog.
   If chats or pipelines must stop, the exit dialog warns that the update will apply and restart the app.
   The updater takes control before normal server shutdown. Forced shutdown is not successful preparation.
   An update prepared after exit has begun waits for the next application attempt.
   Termination signals and startup failures, including closing the splash, do not apply updates.
7. A local installation updates its window and server together. A remote profile updates only the window;
   the selected machine and trusted certificate are preserved.

After confirmed restart, a separate process continues the update. Closing the old window then does not
require reinstalling. If process state cannot be read, resolve that error and resume the existing job.

## Standalone server

Run `grigdesk-ctl` in a terminal, including over SSH. Its menu shows version, channel and background check
results. Without a TTY, an empty invocation prints help. Direct commands:

- `grigdesk-ctl server check-updates [--json]` checks the website.
- `grigdesk-ctl server update-status [--json]` reads installation state and journal without the server.
- `grigdesk-ctl server update [--json]` prepares a server build.
- `grigdesk-ctl server resume-update [--json]` resumes the existing job.
- `grigdesk-ctl server resume-update --rollback` restores the previous release when the new generation
  cannot start on real data, with an `applied_not_started` outcome and no other exit.
- `grigdesk-ctl server update-channel release|dev` explicitly changes channel when no job is active.

A TTY offers application after preparation; without a TTY the job remains ready.
`--restart` on update or resume-update explicitly confirms application and stopping work.
A stopped server remains stopped with `applied_not_started`; start it separately using
`grigdesk-ctl server start --wait`. Downloading does not start the server.
A local application/server pair directs you to the application rather than updating half the pair.
Successful updates release their archives and unreachable generations, preserving the journal,
data and previous generation for rollback.

## Verify and recover

Running describes a live process; installed describes files on disk. Completed confirms the required
components started. `applied_not_started` does not mean the new server is running.
Partial failure preserves the journal and previous generations. Resume in the app or CLI to keep the same target.
Explicit `resume-update --rollback` restores the previous release if the new generation cannot start on real data.
A stopped local server is detected by the unavailable port and does not require a CLI token.
Component probe output is in the installation's `update/<id>/probe-desktop.log` and `probe-server.log`.
Startup noise, such as Electron dbus messages, is visible there but does not itself mean failure.

After a crash, resuming automatically reclaims a lock whose owner is proven dead.
Do not delete it manually. A live or unverifiable owner causes refusal; wait and retry.
Do not bypass signature verification or delete data and saved generations.
After switching local/remote modes, return to the profile matching the confirmed job.
Remote servers update through their own CLI; updating the window does not restart them.
Source installations retain their existing Git update path. Android updates separately.

## Related articles

[Installation](installation.md) · [Backups](data-and-backups.md) · [Diagnostics](troubleshooting.md)
