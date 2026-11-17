# Chat list filters

The chat list shows active conversations; the archive is switched by the compact
"Active / Archive" segment next to the search field. In the full list, the number
of archived conversations appears beside "Archive". The counter is hidden
when the archive is empty or a project is selected. The filters icon sits
immediately after the tabs.

## Project

Choose a project in the rail on the left. On narrow screens, use the "Chat project"
selector above search. In the full list, select the chip beside a chat preview
to filter by that project. The open conversation and its working folder stay in
place. "All chats" returns to the full list. "No project" shows chats without a project.

Search, archive, and the other filters apply within the selected project.
Archived projects are available for reading previous conversations. Deleting a
project registration returns to the full list. If the catalog fails to load,
the selection is kept and you can retry. The choice is remembered for this connection.

Creating a chat in an active project selects its working folder. "No project"
uses the built-in GrigDesk folder. "All chats" uses your usual new-chat settings.
Creating chats is disabled for archived projects.

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
It clears the filters in the panel and keeps the selected project. When the panel is closed, active filters appear as chips below
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
Creating a chat returns to the active list and clears the filters in the panel.
The selected project and search text are preserved. A search may hide the new row.
While connected, new questions and run starts/completions update the state filters.
If an update fails, existing rows remain and the retry action reloads the same selection.
