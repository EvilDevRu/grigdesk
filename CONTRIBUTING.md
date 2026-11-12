# Contributing guidelines

These guidelines apply to people and AI agents working in this repository.
Before making changes, read the [general project instructions](CLAUDE.md).

## Commit messages

- Write the subject and, if needed, the body in English.
- Each commit addresses one task; the subject briefly describes the specific change.
- Keep the subject at 72 characters or fewer, with no trailing period. Use the imperative:
  `add`, `fix`, `remove`, rather than `added`, `fixes`, `removed`.
- A subject is usually enough. Add a body only to explain the reason or
  non-obvious consequences, separated from the subject by a blank line.
- Avoid vague messages such as `update`, `fix stuff`, or `misc changes`.

Use Conventional Commits by default:

```text
type(scope): short summary
```

`scope` is optional; it identifies the affected area, such as `chat`, `web`, or `server`.
Choose the type based on the purpose of the change:

| Type | When to use it |
| --- | --- |
| `feat` | A new feature |
| `fix` | A bug fix |
| `refactor` | A code structure change that preserves behavior |
| `perf` | A performance improvement |
| `docs` | Documentation changes |
| `test` | Test changes |
| `build` | Build or dependency changes |
| `ci` | Automated checks and publishing |
| `chore` | Other maintenance changes |
| `revert` | Reverting a previous commit |

Examples:

```text
feat(chat): add message search
fix(web): preserve scroll position
docs: define commit message rules
```

For a breaking change, place `!` before the colon, for example
`feat(api)!: remove legacy chat endpoint`, and describe the consequences in the message body.

If the user or an explicitly invoked skill requires a different format, such as
`Task <TASK> - <summary>`, follow it. English, brevity, and the prohibition on
co-authorship trailers remain mandatory. Automatically generated merge and revert messages
are allowed in English; manually written descriptions must follow these guidelines.

## Pull requests

- Write the title and the entire PR description in English, including section headings
  and automatically added pipeline signatures.
- The title follows the same `type(scope): short summary` style as a commit message:
  a specific change, imperative wording, at most 72 characters, and no trailing period.
  A format explicitly requested by the user or a skill takes precedence.
- Start the description with the problem and the resulting behavior. Describe the final
  changes for a reviewer who has not read the conversation; leave out the discussion history.
- In `Summary`, briefly explain what changed and why. In `Validation`, list the checks
  actually performed and their results; explicitly note any checks that were not run.
- Add `Notes` when needed for limitations, breaking changes, rollout order, or manual steps.
  The length of the description should match the complexity of the PR.
- When the scope of the PR changes, update its title and description to reflect the final implementation.

The [GitHub template](.github/pull_request_template.md) defines the sections of a new PR.
Replace the prompts with a specific description; remove the optional `Notes` section if it is not needed.

Example title:

```text
fix(web): preserve scroll position when loading older messages
```

Example description:

```markdown
## Summary

Loading older messages used to jump to the bottom of the chat. Preserve the
visible message and scroll offset while the older messages are inserted.

## Validation

- Focused chat scrolling tests pass.
- Manually verified that loading older messages keeps the visible message in place.
```

This example illustrates the format; in an actual PR, list only the checks that were performed.

## Co-authorship

Create commits **without a `Co-Authored-By:` trailer**, regardless of capitalization.
This also applies to lines automatically added by an editor or AI agent.
Before creating or amending a commit, review the entire message and remove any such trailer.

For agents, these guidelines do not replace an explicit human request to commit, push, or create a PR;
the restrictions are defined in the [general project instructions](CLAUDE.md).
