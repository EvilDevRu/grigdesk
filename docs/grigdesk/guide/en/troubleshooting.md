# Troubleshooting

Start with the exact reason and selected machine's state. Keep your draft and determine whether the action already happened.

## Before you begin

Record operation, error time and server/window version.
Do not include keys, pairing QR codes or full private conversations.

## What to do

1. If disconnected, check machine and connection status; wait for recovery or Connect now.
2. Retry history after restoring the network. Do not overwrite it because a response is missing.
3. For executor preparation failures, check installation, sign-in, model and working folder,
   then quota/balance separately.
4. After an interrupted turn, review completed actions. Retrying can repeat external effects;
   verify an unknown result at its destination first.
5. For unsupported features, update server and window consistently. Retry help after restoring connection.
6. Enable diagnostics, reproduce once and save a limited log with event time.

Chat errors have a separate Error card with the complete reason; long paths/messages wrap.
Troubleshooting beneath it opens this article over the chat while preserving the draft,
without retrying the operation or sending an agent message.

For source builds, E0 `factory_source_lock_invalid` can concern temporary test HOME permissions.
The corrected builder creates it privately regardless of terminal settings.
Update source and retry `bin/grigdesk-ctl build server`; do not delete data or locks.
An `ENOENT` package under `server/node_modules` can mean outdated dependencies.
The corrected build reconciles server dependencies before packaging even when node_modules exists.
Update source and repeat the same command. For npm preparation errors, retain the output and check registry access;
application data need not be deleted.

Reopen an interrupted remote-access wizard and inspect the existing job.
Passwords are not saved, so another installation attempt needs fresh SSH input.
Verify changed SSH keys separately; never accept unknown fingerprints automatically.
DNS waiting needs the existing domain pointed to the new VPS; VPN waiting concerns the home server.
For a running service with an unreachable public port, check DNS, NAT and provider firewall.
The wizard does not disable protection or alter unrelated services.
Do not delete phone profiles or relay configuration for network failures.

If Window installation reports an invalid server ELF description after successful server/AppImage builds,
save the build log. Old installers hardcoded the release number; the corrected installer checks protocol compatibility
independently of version. Update source and repeat the build, preserving application data.

If a startup error names forbidden `GRIGDESK_HOME` or `GRIGDESK_ENV_FILE`, remove that
assignment from `.env`. Data roots come from the installation or launch environment;
the settings file cannot override them. The error follows the window's language and
preserves the key name.

## Result

The failure is narrowed to connection, version, access, quota or operation,
with saved messages and completed effects considered before retrying.

## Limits and recovery

Normal shutdown cancels Kimi quota checks and waits for their processes.
Investigate remaining processes by ownership: another working copy or standalone executor can still run.
Do not kill all executor processes by name.
Telegram shutdown cancels its current request and saves unprocessed cards for the next launch.
If sending began but no response arrived, it does not resend automatically;
check Telegram and current `/status` first.
For `browser_socket_busy` after shutdown, save shutdown logs and time.
The corrected watchdog bounds shutdown of its own server, including stuck DNS, freeing the socket.
Another live server's socket stays protected. Do not delete it manually or kill all processes by name.
These fixes require a package update and manual restart.

After a desktop renderer crash, a native dialog offers Reload interface or Keep window.
Reload affects only the interface; server/jobs continue, but unsaved input may be lost.
Another crash requires another answer; there is no automatic retry.
Record time and terminal Desktop messages if available; page logs may lack native crash reasons.
Do not resolve unknown outcomes by deleting data/locks or repeating operations in bulk.
If manual recovery is requested, keep backups and contact the machine owner.
Help does not execute repairs itself.

## Related articles

[Window log](web-log.md) · [Connections](connections.md) · [Updates](updates.md) · [Conversations](chats.md)
