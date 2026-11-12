# Troubleshooting

Start with the exact cause and selected machine's state. Preserve your draft and determine whether the action completed.

## Before you start

You need the operation name, error time and server/window version. Do not attach keys, pairing QR codes or complete personal conversations.

## What to do

1. For disconnection, check the machine and connection status. Wait for recovery or press Connect now.
2. If history cannot load, retry after network recovery. Do not create new history over a missing response.
3. If executor preparation fails, check installation, authorization, model and working directory. Check quota and balance separately.
4. After a turn interruption, read the completed-actions feed. Retrying may repeat external effects; check the destination first when the outcome is unknown.
5. If the server lacks a feature, update server and window consistently. Reload unavailable help after fixing the connection.
6. Enable diagnostics, reproduce the problem and keep a limited log with error time for analysis.

Chat errors appear in a separate Error card. Its full cause is below; long paths and messages wrap. Press Troubleshooting below the cause to open this article over the conversation. Your draft remains; help neither retries the operation nor sends a message to an agent.

When building from source, E0 with `factory_source_lock_invalid` may concern the permissions of the temporary test HOME directory. The fixed builder creates it privately regardless of terminal settings. After updating source, repeat `bin/grigdesk-ctl build server`; you do not need to delete data or lock files for this error.

If the remote-access wizard is interrupted, reopen it and read job state. Passwords are not saved: repeating installation needs new SSH input. Verify a changed SSH key separately; never automatically approve an unknown fingerprint. Waiting for DNS requires pointing the previous domain to the new VPS. Waiting for VPN concerns the home server. If the service is available but its public port is not, check DNS, NAT and the hoster's firewall; the wizard neither disables protection nor changes unrelated services. Do not delete the phone profile or relay configuration for a network failure.

If a successful server and AppImage build is followed by Window: installation reporting “Invalid server ELF description”, keep the build log. An older installer hardcoded the release number, so the error repeated after version changes. The fixed installer checks protocol compatibility independently of release number. After updating source, repeat the selected build; application data remains.

## Result

The cause is narrowed to connection, version, access, quota or a specific operation; saved text and completed actions are accounted for before retrying.

## Limitations and recovery

On normal server shutdown, the Kimi limits probe is cancelled and the server waits for its processes to end. Identify ownership of any remaining processes: another GrigDesk working copy or an independent executor session may continue separately. Do not terminate every executor process by name.

When stopping, the Telegram remote cancels the current network request and retains unprocessed cards for next startup. If sending started but no response arrived, that card is not automatically resent: check Telegram and current state with `/status`.

If the next startup reports `browser_socket_busy` after shutdown, preserve the shutdown log and error time. In the fixed version, a separate watchdog bounds termination of its own server, including hung DNS, and releases the socket for the next launch. A socket used by another live server remains protected; do not manually remove it or kill all processes by name. These fixes take effect after a package update and manual restart.

If the desktop interface crashes, a native dialog offers Reload interface or Keep window. Reload affects only the interface: the server and running jobs continue. Unsaved text may be lost. Another crash requires another answer; there are no automatic retries. When asking for help, give the crash time and save Desktop messages from the terminal if launched there. The page log may lack the native crash cause.

Do not address unknown outcomes by deleting data or lock files or repeating operations in bulk. If manual recovery is requested, keep backups and contact the machine owner. Help does not run repairs itself.

## Related articles

[Window log](web-log.md) · [Connections](connections.md) · [Updates](updates.md) · [Conversations](chats.md)
