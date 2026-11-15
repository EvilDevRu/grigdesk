# Chat list filters

The chat list shows active conversations; the archive is switched by the
"Active / Archive" segment next to the search field.

## Filters

The funnel button expands a panel under the list header. It has no visible text label;
hover to see the "Chat filters" tooltip. The number beside the funnel shows how many
filters are active:

- **State** — the "Unread", "Awaiting reply", and "Working" buttons.
  Selected buttons are highlighted; press again to turn off their filters.
- **Task** — a B24 task number, or the "With task" / "Without task" modes.
  A typed number takes priority over the mode.
- **Executor** — one of the executors from the live catalog; "Any" removes this restriction.
- **Freshness** — last 24 hours, last 7 days, last 30 days.

Fields appear in pairs and stack in a narrow panel. The "Reset filters" arrow button
sits at the top beside the state label and becomes available after selecting a filter.
It clears all filters. When the panel is closed, active filters appear as chips below
the "Filters" button: the cross removes one filter. The open panel does not duplicate
the selection with chips. On every screen, the button shows only its funnel and active
filter counter. An empty result also offers a reset.
Filter selection and the Active / Archive scope are remembered between visits.
Chat search works together with filters. If the server does not support filters
yet, the button is hidden and saved filters are not applied — the list works
as before. If the server is rolled back while the window is open, a rejected request
triggers a compatibility check and restores the regular list. If the network is
unavailable, the error remains visible with a retry action. After reconnection,
stale rows can remain until the list is loaded again. Reloading the window retrieves
current results; returning to an already loaded filter can reuse its cached page.

The server applies the filters, so "Show more" loads exactly the filtered chats.
Creating a new chat resets the filters. With an empty search, the new conversation
is visible; existing search text is preserved and may hide the new row.
While connected, new questions and run starts/completions update the state filters.
If an update fails, existing rows remain and the retry action reloads the same selection.
