# Connecting Qwen Code

GrigDesk runs Qwen Code 1.0 Preview.2 on Linux x64 in a bwrap sandbox. You can install it
from the executor card. GrigDesk downloads the official archive and verifies it before
installing it in the application data directory.

## Prepare access and models

1. Open Settings → Executors → Qwen Code → Overview and click Install. If Preview.2 is
   already ready, continue to step 2. The card shows the version after installation.
   If the download fails, click Install again.
2. On Access, select the API service and region matching your key. The default is Alibaba Model Studio in Singapore.
   QwenCloud, Coding Plan, Token Plan and OpenRouter are separate services with non-interchangeable keys.
   For an Individual Plan or Team Plan at qwencloud.com, choose QwenCloud Token Plan — Singapore.
   Alibaba Coding Plan is a different service whose models may differ from your QwenCloud subscription.
3. Enter the API key and Apply. Empty input preserves the saved key; removal is a separate action.
4. The chosen service's API loads models automatically. No manual JSON is needed:
   GrigDesk prepares private CLI settings. New models appear after a catalog refresh.
5. Select Qwen and a model in chat. Catalog failures show a reason such as HTTP 401.
   Check service, region and key. GrigDesk never tries the key against other services.
   Loading the catalog does not prove a paid model request will succeed.

If Qwen is missing from the list, use “Qwen Code · No models” at its bottom when offered,
or open Settings → AI executors. The card explains the issue and offers rechecking or setup.
Overview shows the verified runtime version. The card hides results from servicing the old npm copy.
Saving access remains successful while models reload. After connection loss, Access saved offers Recheck;
do not re-enter the saved key. Unsaved access shows Save connection and Apply;
rechecking before saving uses the old connection.
The short model list keeps confirmed new and third-party models distinct.
Chat shows only models usable for text conversation, newer ones first.
Video, speech and other non-chat service models are not listed at all
and cannot be selected for chat. Older versions of chat models can be
enabled in Settings → AI executors → Models.

If you already configured `modelProviders` in Qwen CLI, GrigDesk uses it without modifying it.
Service selection is hidden and access uses the configured `envKey` names.
Invalid JSON must be repaired at its source, rather than replaced automatically.

## Chat operation

For a project with several repositories, the primary repository is the starting directory.
Other repositories are additional working roots. The sandbox masks `.env` and `.qwen` in those
roots. The move to Preview.2 keeps the GrigDesk conversation and starts a new native session.
Later turns resume the saved Preview.2 session. Stop interrupts the current turn.

GrigDesk checks tool requests before execution. Ask shows an approval card. Auto uses the shared
GrigDesk classifier and asks when it cannot approve a request. No confirmations lets approved
operations proceed immediately. Plan blocks writes and shell commands. Select a working
permission mode to act on a plan.

You can attach PNG, JPEG, GIF and WebP images with a model that declares vision support.
Limits are 10 images, 10 MB each and 32 MiB total.

## Preview.2 capabilities

The sandbox supports reading, file search, editing, Bash, reading pages, foreground subagents and
server-approved work MCP tools. A follow-up sent while Qwen is responding joins the same session
queue. Qwen replies in a separate block after the current request.

Host mode requires separate confirmation. It grants access to the server user's files and
services. Tool approvals and the direct SSH restriction follow the selected settings.
Enable keeping chat agents alive between turns and run GrigDesk as a systemd user service.
Close the process manually in the live sessions list. Background tasks and automatic idle
cleanup are unavailable in Preview.2.

Open the Qwen icon in the top bar. The Subscription quota bar is disabled while the integration
has no balance or reset time. The last measured turn's input and output token counts appear
below the bar. The measurement is kept until GrigDesk restarts.
