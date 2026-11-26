# DeepSeek and GLM

DeepSeek and GLM use a compatible standalone Harness distribution.
Access and payment configuration depend on the selected service.

## Before you begin

Install a compatible binary through the supported distribution and configure access in the executor's settings.
Its absence does not disable other executors.

## What to do

1. Open Settings → Executors, choose the service and enter access keys if required.
2. Save and Recheck. Read the version, availability and any incompatibility message.
3. Select an available model and mode in chat. Ask requires decisions before changes or commands;
   Auto permits independent work in the allowed folder; Read-only disables writes and shell.
   DeepSeek's native web search and public-page reading need no separate permission in all three modes.
4. Check DeepSeek balance, plan information and forecast in its popover.
   Follow the provider link for current terms.
5. After interruption, review completed work and use the offered continuation in the same session.

## Result

### GLM chat access

Open **Available in this chat** next to the composer to check folder permissions, image input,
search configuration, available browser tabs, project MCP servers, and tool failure counts in loaded history.

- For web search, set the service variable `GRIGDESK_GLM_SEARCH_API_KEY` to a DeepSeek search key.
- Select a project MCP server in the dialog or send `/mcp name request`. Approve its startup and each call.
- For extended work, send `/goal objective`. The activity feed shows each round and the outcome.
  Use **Stop** to interrupt the run. Send `/goal resume` to resume the goal.

The executor uses the available models and selected policy.
Keys saved through the window apply on the server without manual file editing.

## Limits and recovery

GLM's ordinary API and Coding Plan are separate access profiles with separate keys and limits.
One executor profile is active at a time.
On Harness 0.1.5-rc.2, the optional patch adds GLM-5.4 to both profiles.
It also adds GLM-5.3-FlashX and GLM-5.3-FlashX-Legal to the standard API profile.
Chat requires a build approved for the selected mode. Model responses depend on access at Z.ai.
DeepSeek cannot identify the account belonging to a replacement key during sign-in.
Replacement requires explicit confirmation; cancelling keeps the old key.
Confirmation preserves the profile ID and history but starts a native session without previous memory.
Signing into an inactive profile does not activate it.

Metadata checks make no paid model request and do not prove API-key acceptance.
Prices and models change; this guide does not fix prices. Harness primarily restricts writes to the working folder;
additional paths may require permission. Supported project MCP servers do not start in read-only mode.
The distribution checks update/rollback compatibility. Operations with unknown outcomes are not repeated automatically.

The model list may take a little longer to appear after you install or update Harness.
On the first catalog refresh, GrigDesk extracts and verifies the new distribution.

If GLM or DeepSeek reports a lost connection to the model on a route with broken IPv6,
update the standalone Harness to a build with the IPv4 and IPv6 fallback fix.
Once a compatible build is installed, the next turn uses it without restarting GrigDesk.
Open the same conversation and continue where it stopped.

When GLM reports an exhausted Coding Plan quota, GrigDesk ends the turn without scheduling a one-minute continuation.
Check the reset time in GLM limits and resume after recovery. The Z.ai response code identifies this failure
even if Harness labels it a rate limit.

If Z.ai returns code `1311`, the model is unavailable on the current Coding Plan.
GrigDesk shows the reason and ends the turn. Select an available model in the same conversation.
An expired subscription, an account restriction, or a key type restriction also gets a specific message.
GrigDesk can resume the same turn after a delay if the request rate is temporarily limited.

If GLM reports that its mandatory policy check failed while writing a long document,
an older GrigDesk version may have mishandled non-ASCII text. After installing a version
with the fix, send a new message in the same conversation: "Continue where you stopped;
check the saved files first." There is no need to clear history or reset memory.
The operation is not repeated automatically. This general policy-check error can also
have other causes that need diagnosis.

## Related articles

[Conversations](chats.md) · [Working folder](chat-workdir.md) · [Settings](settings.md)
