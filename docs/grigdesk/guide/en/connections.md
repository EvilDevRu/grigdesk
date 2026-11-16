# Machines and connections

Desktop and Android applications share an interface; the selected machine performs actions.

## Before you begin

For remote work the server must be running and reachable through the configured direct or relay route.
Install the full Android application separately.

## What to do

1. Open machines and select the local installation or add a remote one.
2. Prepare pairing in the server's access/devices section. For phones, use the full application's QR or pairing string.
3. Scan/paste it in the client, verify the machine and confirm.
4. Wait for connection. After temporary failure, Connect now and inspect route status.
5. Revoke devices on the server when needed. Revoking the current device disconnects it.

## Remote access and replacing a VPS

On the home server, open Settings → Connections → Server access → Remote access
or run `grigdesk-ctl relay setup`.
Verify the home machine: console and window share its job list, including first setup.
Enter a name, SSH address, username and password/key file.
Verify the SSH fingerprint against a trusted source, review Ubuntu/Debian x64 with systemd checks and confirm changes.
The VPS needs neither Docker nor Node.
After channel verification, obtain QR and wait separately for the phone to connect.
You may close and later reopen the same job; do not delete configuration for a temporary connection failure.
Select a particular job to continue, or 0 in the console for a new VPS.
If an old job awaits fingerprint, access or installation confirmation, end that wait with its separate confirmation
before entering a new server. This does not cancel an already accepted installation.
Escape closes only the wizard and returns focus to settings.

For another VPS use Restore on new server or `grigdesk-ctl relay restore`.
The home installation keeps identity, certificates and devices.
With the same DNS/port, point DNS to the new VPS and recheck without new pairing.
For a changed address, use Connection parameters → Change address → Update route by QR or string on the phone
and confirm the selected machine's QR. Keys and trust remain.
If unavailable, update the app in place without deleting data.
When changing a running service on the same VPS, the wizard backs it up before channel checks and restores it on failure.
If SSH is lost and rollback unconfirmed, inspect the VPS and retry restoration with SSH access;
home identity and phone keys remain. DNS waiting continues until DNS points to the new VPS.

## Result

The client reads the selected server's data and help. Switching machines does not transfer conversations.
Window version belongs to this computer; server version belongs to the selected machine.
Update a remote server using its CLI. Connection loss never permits an automatic switch to local.

## Limits and recovery

Temporary shell unavailability preserves the machine and retries its state, with a message in the interface language.
Create expired pairings again and keep QR/strings private.
A changed server identity requires owner verification.
Selecting remote does not itself stop the local server. The older mobile client uses a separate protocol.
A verified relay channel and connected phone are separate results: a running service and QR do not prove phone connection.
Preserve records, keys and devices during temporary failures; deleting configuration is a separate action.
Keep the previous relay identity when replacing a VPS.

## Related articles

[Getting started](getting-started.md) · [Updates](updates.md) · [Data](data-and-backups.md)
