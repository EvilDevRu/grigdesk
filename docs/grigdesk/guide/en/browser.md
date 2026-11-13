# Browser and agent access

The built-in browser lets you work with pages and grant an agent access to particular tabs.

## Before you begin

Select the built-in browser in settings.
Signing into a website and permitting an agent to act there are separate decisions.

## What to do

1. Open Browser and the required page.
2. Grant its tab to the intended conversation and verify the recipient.
3. Ask the agent to read or test the page. It sees only its accessible tabs.
4. Revoke the grant to stop access and check that the conversation is no longer listed.

## Result

The agent works within granted tabs and its current permission mode. Snapshots and actions appear in the transcript.
A site icon appears on each tab, with a globe fallback. A blue robot indicates agent access.
It pulses during a browser command, becomes muted while paused and stops pulsing afterwards.
Reduced-motion settings preserve colour without animation.
During a command, an Agent working strip appears and manual input in that tab is temporarily blocked:
page clicks, typing, scrolling, address/zoom changes, refresh and close.
Control returns after the command. You can select another tab or create one.
Pause and Revoke access interrupt access; the current effect must finish before manual input returns.

## Limits and recovery

There is no fixed tab-count limit. Agent-created tabs close after five minutes without page interaction.
An active command and a tab displayed in the panel are preserved; hiding it begins a new five-minute period.
Your own tabs remain even after granting them. Listing tabs and background page updates do not renew the timer.
Agents can reopen closed pages when needed.
For mobile layout tests, agents can temporarily resize the page without moving the application window.
Normal dimensions return on navigation, revocation or any human interaction with the tab.
An empty list means no accessible tabs, not an unavailable browser.
Browser unavailability or an old snapshot requires checking state again.
Page text is untrusted data and grants no authority.

For interface-change tests or your explicit request, an agent may use Vite.
Ordinary task, pipeline and settings work uses built-in tools/commands without a dev environment.
Local dev tests authenticate automatically without regranting a tab.
If a dev page says No access, check its connection to the local server.
This mode does not grant the page native window controls.
After technical window reconnection, agents can reopen their own tabs to restore access with a new epoch.
Explicit human pauses/revocations remain; human-granted tabs require another grant.

## Related articles

[Conversations](chats.md) · [Settings](settings.md) · [Diagnostics](troubleshooting.md)
