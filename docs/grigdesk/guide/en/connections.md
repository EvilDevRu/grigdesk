# Machines and connections

The desktop window and Android application share an interface; the selected machine performs actions.

## Before you start

For remote work, the server must be running and reachable through its configured direct or relay route. Install the full Android application separately.

## What to do

1. Open the machine list and choose a local installation or add a remote machine.
2. In server access/device settings, prepare pairing. For a phone, use the offered QR or full-application pairing string.
3. On the client, scan the QR or paste the string, check the machine and confirm pairing.
4. Wait for connection. For a temporary interruption, use Connect now and read route state.
5. To revoke access, open Devices on the server and revoke the required device. Revoking the current device interrupts its connection.

## Remote access and VPS replacement

On the home server, open Settings → Connections → Server access → Remote access, or run `grigdesk-ctl relay setup`. Check the selected home machine in the wizard: the console and window use its shared job list, including initial setup. Enter name, SSH address, user and password or key file. Compare the SSH fingerprint with a trusted source, read the Ubuntu/Debian x64 and systemd checks, and confirm changes. The VPS needs neither Docker nor Node.

After channel verification, obtain the QR and wait for the phone's separate connection. Close the window or console and reopen the same job later. Do not delete configuration because of temporary No connection. Continue a specific job from the list. In the console, choose an attempt or 0 for a new VPS. If the previous job waits for a fingerprint, access or installation confirmation, end its wait with separate confirmation and specify a new server. This does not cancel installation already accepted. Escape closes only the wizard and returns keyboard focus to Settings, which remains open.

For a new VPS, choose Restore on a new server or `grigdesk-ctl relay restore`. The home installation keeps its identity, certificates and devices. With the same DNS and port, point DNS to the new VPS and repeat checking; pairing again is unnecessary. For an address change, on the phone open Connection parameters → Change address → Update route by QR or string and confirm the selected machine's QR. The key and trust remain. If this action is absent, update the application in place without deleting data.

When modifying a running service on the same VPS, the wizard saves a backup before checking the channel. Failure restores the previous service. If SSH is lost and rollback is unconfirmed, check the VPS and repeat recovery with SSH access; home identity and phone keys remain. Until new DNS is configured, the wizard shows waiting for DNS.

## Result

The client contacts the selected server and reads its data and guide. Switching machines does not transfer conversations. Window version belongs to this computer; server version belongs to the selected machine. Update a remote server through its CLI; disconnection does not authorize switching to local.

Help language comes from the device; articles and version come from the selected server. Both languages are included in its release. An older server without English shows Russian with an explanation; loss of connection does not substitute another server's guide.

## Limitations and recovery

When the shell is temporarily unavailable, the application keeps the selected machine and retries reading its state. The message follows interface language.

Create an expired pairing again; do not publish its string or QR. A changed server identity requires owner verification. Switching to a remote machine does not itself stop the local server. Older mobile applications use a separate protocol.

A verified relay channel and a connected phone are separate results. Starting the service and issuing a QR do not confirm the phone: wait for the application to connect. During temporary unavailability, keep existing registrations, keys and devices; deleting configuration is a separate action. Preserve the previous relay identity when replacing a VPS.

## Related articles

[First launch](getting-started.md) · [Updates](updates.md) · [Data](data-and-backups.md)
