# Glossary

These terms distinguish task data, the agent's workspace and execution state.

## Before you start

Names refer to the selected server and current section.

## What to do

- **Project** — a registration of a name, working repositories and factory-profile connections.
- **Working directory** — the directory where an agent starts; project and task help select it but do not replace permission mode.
- **Executor** — an adapter for an installed service or CLI; **model** — the selected model from that service.
- **Turn** — work on a sent message until a result, stop or error.
- **Context** — model working memory; visible messages and account quota are separate.
- **Task** — a request with an expected result; **triage** — evaluation before execution.
- **Route** — a sequence of stages and checks; **attempt** — one execution of a route.
- **Gate** — a scheduled stop for a human decision; an **arbiter** helps analyze a stop.
- **Profile** — project and automation settings; **environment** — an already running setup for verification.
- **Plugin** — an additional capability; an installed package and enablement are separate states.

## Result

Read status names in the operation's context; one component being ready does not mean the whole task succeeded.

## Limitations and recovery

Usage numbers without units, unknown measurements and missing data cannot be treated as zero.

## Related articles

[Projects](projects.md) · [Tasks](tasks.md) · [Pipelines](pipelines.md) · [Memory](chat-context.md)
