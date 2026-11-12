# DeepSeek and GLM

DeepSeek and GLM use a compatible standalone Harness distribution. Access and payment setup depend on the service selected.

## Before you start

Install a compatible binary through the standard distribution and configure access in the relevant executor's settings. Missing Harness does not disable other executors.

## What to do

1. Open Settings → Executors, select the service and fill in Access keys if required.
2. Save and press Recheck. Read the version, availability and incompatibility messages.
3. In chat, choose an available model and mode. Ask requires a decision before a change or command; Auto permits independent actions in the allowed directory; Read only forbids writes and shell. DeepSeek's built-in web search and public-page reading need no separate approval in any of these three modes.
4. For DeepSeek, check account resources in its popover: balance, plan information and forecast. Use the provider link in the interface for current terms.
5. After an interruption, review completed work and use the offered continuation in the same session.

## Result

The executor starts with available models and the chosen policy. A key saved through the window is applied by the server without manual file editing.

## Limitations and recovery

Access profiles treat GLM's ordinary API and Coding Plan as separate connections with their own keys and limits. Only one executor profile is active at a time.

When signing in to DeepSeek again, the new key's account ownership cannot be determined. Replacement requires explicit confirmation; cancel keeps previous access. After confirmation, the profile ID and history remain, but the executor starts a new session without old memory. Signing in again to an inactive profile does not activate it automatically.

Metadata checking makes no paid request and does not prove API key acceptance. Plans and models change; this guide does not fix prices. The working directory is Harness's main write boundary; additional paths may need permission. Project MCPs use the supported contract and do not start in read-only mode. Update/rollback compatibility is checked by the distribution; an operation with an unknown outcome is not repeated automatically.

If GLM reports an exhausted Coding Plan limit, GrigDesk ends the turn without scheduling automatic continuation in a minute. Open GLM limits, check reset time and continue after quota recovers. This refusal is recognized by Z.ai's response code even if Harness labels it rate limiting. Harness may perform its own retries before GrigDesk receives the final error.

## Related articles

[Conversations](chats.md) · [Working directory](chat-workdir.md) · [Settings](settings.md)
