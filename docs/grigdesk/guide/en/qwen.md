# Connecting Qwen Code

Qwen Code uses an external npm CLI and an API key for the selected model service.
Chats require a Linux server with a working bwrap sandbox. The CLI needs Node.js 22 or newer
and local headers for the selected Node during installation; missing headers cause refusal before installation.

## Prepare access and models

1. Open Settings → Executors → Qwen Code and install the CLI using its button.
   Updating and version checks are on the same page.
2. On Access, select the API service and region matching your key. The default is Alibaba Model Studio in Singapore.
   QwenCloud, Coding Plan, Token Plan and OpenRouter are separate services with non-interchangeable keys.
   For an Individual Plan or Team Plan at qwencloud.com, choose QwenCloud Token Plan — Singapore.
   Alibaba Coding Plan is a different service whose models may differ from your QwenCloud subscription.
3. Enter the API key and Apply. Empty input preserves the saved key; removal is a separate action.
4. The chosen service's API loads models automatically. No manual JSON is needed:
   GrigDesk prepares private CLI settings. Installation, updating and reinstallation use the same access;
   refreshed catalogs expose new models at the top of the list.
5. Select Qwen and a model in chat. Catalog failures show a reason such as HTTP 401.
   Check service, region and key. GrigDesk never tries the key against other services.
   Loading the catalog does not prove a paid model request will succeed.

If Qwen is missing from the list, use “Qwen Code · No models” at its bottom when offered,
or open Settings → AI executors. The card explains the issue and offers rechecking or setup.
Use Overview to update or reinstall an incompatible CLI.
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

Installation checks dependency installer hooks before confirmation.
“This installation method is not verified for the version” requires reviewing the changed package.
Verified CLI versions 0.27.2 and 0.27.3 work with this protection enabled.
If an older server reports “Подготовка операции не удалась” (operation preparation failed)
while updating to 0.27.3,
apply the GrigDesk update containing the verified profile for that version,
restart the server manually, and retry the Qwen update.
The optional microphone backend uses a prebuilt addon; compiling it needs Python 3, make and a C++ toolchain.
It is not required for GrigDesk chat.

## Chat operation

A project may have several repositories. The primary repository is the starting directory;
others are additional readable and writable roots. Task conversations use their task working copies.
Their common parent is not granted. Changing folders, roots or access separates native memory from
the previous session while keeping GrigDesk history. Stop interrupts the process;
continuation uses the saved session. Successful tools show ✓ and failed tools ✕ in live and saved history.

The requested-model marker in turn status means the CLI has not confirmed session selection.
After confirmation it disappears and the model is stored with the reply.
It remains if the CLI does not report the current model.
Reasoning and replies form continuous blocks rather than one card per streamed fragment.
Previously saved fragments are also combined when displayed without changing messages or memory.

Long reasoning, tools and approval waits do not stop after 30 seconds. Stop works during each state.
If an installed version reports `ACP timeout: session/prompt` around 30 seconds, update the server,
restart it manually and retry. Changing API service or re-entering a saved key does not fix that error.

Effort levels come from the installed CLI separately for each model. Verified CLI 0.27.2 reports
`none`, `low`, `medium`, `xhigh` for Qwen4 Max Preview. Reasoning-switch models offer `none` and `default`;
models without such a setting show no selector. The CLI confirms effort before sending a prompt.
After a catalog change, reselect an unrecognized level.
Generic fallback levels for unknown models do not confirm their capabilities, so some third-party models
may have no effort control until CLI metadata exists. That does not establish that their API lacks reasoning.
Context-window size is the CLI's working setting, not an independent check of the service's request limit.

Sandboxing also hides `.env` and `.qwen` symlinks in every working root behind empty data,
preserving the original links and content on the server. Early failures show the sandbox reason
rather than an incidental `/proc` error for an exited process.
Ask, Auto, Plan and No confirmations retain sandbox boundaries and direct-SSH server checks.
An incompatible CLI guard protocol causes visible refusal, never unprotected fallback.
Without bwrap or on another server OS, turns are unavailable.

Auto uses Qwen's native automatic mode: ordinary changes within selected directories proceed independently;
the CLI evaluates other actions, potentially making extra model requests and consuming quota.
Unavailable assessment may fall back to a permission question. Ask keeps manual confirmations;
No confirmations skips them while preserving sandbox boundaries.
Update Qwen Code if the CLI does not support the chosen mode.

Attach PNG, JPEG, GIF or WebP, including without text. Images go directly to Qwen and require a vision-capable model.
Limits are 10 images, 10 MB each and 32 MiB total. Put other file types in the working folder and mention them.
Reattach missing images and update an incompatible CLI in executor settings.
GrigDesk does not yet support Qwen quota retrieval; this is an integration limitation, not a service response.

## Native tools

GrigDesk permits search and page reading, todos, memory, subagents and agent commands, skills, LSP,
notebook editing, image/media processing, native schedules, goals and workflows.
Availability also depends on CLI version, configuration and service.
Permitting web search does not give search access to a model-only API key.

Agent questions appear in ordinary GrigDesk cards, supporting multiple choices when offered and free text.
Plan approval shows the plan and CLI-provided continuation choices; approval can allow edits in the same turn.
Cancel and Stop end the wait.
During work, send text or image clarification using Send. It enters the current turn:
Qwen may interrupt generation, answer and continue the original task.
Delivery status confirms transfer to the executor, rather than model acknowledgement.
While a question card awaits an answer, composer messages wait for the next turn.

Stop shows “⏹ Turn stopped.” without a red error card. Completed actions and available session memory remain;
the next message continues the conversation. File changes are not rolled back.
Sandbox and direct-SSH restrictions also apply to subagents and these tools.
Plan mode blocks shell, edits, media processing and workflow. Native page reading permits localhost and private addresses.
In CLI 0.27.2, subagents can fail with `Tool invocation guard failed` because the CLI loses the parent guard context.
Allowing subagents does not fix it; a compatible external CLI fix is needed. GrigDesk does not disable protection.

Media tools require executable `ffmpeg` and `ffprobe`; otherwise chat and other tools remain available.
LSP needs a configured language server and external processing services need their own access.
Qwen's process lasts for one turn. Native schedules and background tasks do not survive its exit;
permitting those tools does not create a permanent GrigDesk worker.

## Verification limits

Pipelines offer a Qwen runner using the same model source. Select executor and model in the stage editor.
This grants no extra filesystem rights: checking stages write state and implementation stages write the working folder.
Verify a node separately in a test environment before assigning real tasks.

Automated checks used real CLI 0.27.2 with a local test API for catalog setup and turns without an original
`settings.json`, plus a node with a test CLI. They cover a real API pause exceeding 30 seconds,
long approval waits, Stop, stream errors, clarification delivery during generation and separately saved replies.
They verify exact image bytes in ordinary turns and clarification, additional working roots,
native Auto, refused automatic assessment and fallback to manual confirmation.
Live-model clarification, actual image recognition, installation from the card and browser acceptance are separate checks.
Paid smoke testing requires a real key entered by its owner through Access settings after a manual server restart.
