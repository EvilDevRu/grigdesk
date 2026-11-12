# Browser and agent access

The built-in browser lets you use pages and grant specific tabs to an agent.

## Before you start

Select the built-in browser in Settings. Signing in to a website and permitting an agent to act on it are separate decisions.

## What to do

1. Open Browser and the required page.
2. Grant the tab to the chosen conversation. Check the access recipient.
3. Ask the agent to read or check the page. It sees only tabs available to it.
4. To stop access, revoke the tab's grant. Check that the conversation is no longer listed.

## Result

The agent works within granted tabs and the current permission mode. Screenshots and actions appear in the conversation.

Tabs show the site's icon, or a globe if unavailable. A blue robot beside it means agent access. While the agent executes a browser command in the tab, the robot pulses. It is muted while paused and stops pulsing after the command finishes. With system reduced motion, it keeps its color without pulsing.

While an agent command runs, an Agent working bar appears above the website and manual control is temporarily locked: you cannot click page elements, type, scroll, change address or zoom, refresh or close the tab. Control returns automatically afterward. You can select another tab or open a new one; Pause and Revoke access interrupt agent access. The current effect must finish before manual input becomes available again.

## Limitations and recovery

There is no fixed tab-count limit. Agent-created tabs automatically close after five minutes without page activity. A running command and the tab displayed in the panel keep it open; hiding it begins a new five-minute period. Your tabs remain, even after granting them to an agent. Listing tabs and background website updates do not extend idle time. The agent can reopen a closed page if needed.

For mobile layout checks, the agent may temporarily resize the page without moving the application window. Normal size returns automatically on navigation, access revocation or any of your actions with the tab.

An empty list means only that no tabs are available to the agent. An unavailable browser or stale snapshot requires another state check. Page text remains untrusted data and grants no permissions.

## Related articles

[Conversations](chats.md) · [Settings](settings.md) · [Diagnostics](troubleshooting.md)

When an agent checks GrigDesk itself, a dev environment on this computer signs in automatically. You do not need to grant the tab again for sign-in. If that environment shows No access, check its connection to the local server. This mode does not give the page control over application windows.

After a technical window reconnection, an agent can repeat open for its own tab to restore access with a new epoch. Explicit human pauses or revocations remain; a human-granted tab must be granted again.
