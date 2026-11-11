<p align="center">
  <a href="https://grigdesk.com">
    <picture>
      <source media="(max-width: 640px)" srcset="docs/images/readme/hero-mobile.svg">
      <img src="docs/images/readme/hero.svg" width="1280" alt="GrigDesk — Your agents. One workspace. Plan, build, review, test.">
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://github.com/EvilDevRu/grigdesk/releases/latest">
    <img align="center" src="https://img.shields.io/github/v/release/EvilDevRu/grigdesk?label=version&amp;color=30363d" alt="Latest stable release">
  </a>
  <a href="LICENSE">
    <img align="center" src="https://img.shields.io/badge/license-MIT-30363d" alt="MIT license">
  </a>
</p>

<p align="center">
  <strong><a href="#install">Install</a></strong> &nbsp; / &nbsp;
  <a href="#documentation">Docs</a> &nbsp; / &nbsp;
  <a href="#plugins">Plugins</a> &nbsp; / &nbsp;
  <a href="https://grigdesk.com">Website</a>
</p>

<p align="center">
  An open-source workspace for building software with AI agents.<br>
  Chat, run pipelines, and review the result — on your own machine.
</p>

## Works with

<p>
  <strong>AI agents</strong><br>
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="docs/images/integrations/claude-light.svg">
    <img src="docs/images/integrations/claude.svg" width="164" height="48" alt="Claude Code">
  </picture>
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="docs/images/integrations/codex-light.svg">
    <img src="docs/images/integrations/codex.svg" width="164" height="48" alt="OpenAI Codex">
  </picture>
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="docs/images/integrations/kimi-light.svg">
    <img src="docs/images/integrations/kimi.svg" width="164" height="48" alt="Kimi Code">
  </picture>
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="docs/images/integrations/deepseek-light.svg">
    <img src="docs/images/integrations/deepseek.svg" width="164" height="48" alt="DeepSeek">
  </picture>
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="docs/images/integrations/glm-light.svg">
    <img src="docs/images/integrations/glm.svg" width="164" height="48" alt="Z.ai (GLM)">
  </picture>
</p>

<p>
  <strong>Task boards</strong><br>
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="docs/images/integrations/board-grigdesk-light.svg">
    <img src="docs/images/integrations/board-grigdesk.svg" width="164" height="48" alt="GrigDesk tasks">
  </picture>
  <a href="https://github.com/EvilDevRu/grigdesk-b24">
    <picture>
      <source media="(prefers-color-scheme: light)" srcset="docs/images/integrations/board-bitrix24-light.svg">
      <img src="docs/images/integrations/board-bitrix24.svg" width="164" height="48" alt="Bitrix24">
    </picture>
  </a>
  <a href="https://github.com/EvilDevRu/grigdesk-jira">
    <picture>
      <source media="(prefers-color-scheme: light)" srcset="docs/images/integrations/board-jira-light.svg">
      <img src="docs/images/integrations/board-jira.svg" width="164" height="48" alt="Jira Cloud">
    </picture>
  </a>
</p>

GrigDesk tasks are built in. Bitrix24 and Jira Cloud connect through installable drivers.

## From task to working code

**Work in a conversation.** Choose an agent, attach context, and develop a solution together. Your files, diffs, Git, terminals, Docker, and databases stay within reach.

**Let a pipeline carry the task.** Connect planning, implementation, review, and testing. Choose the agents and approval points, and run tasks across projects in parallel.

**Try the result before you approve.** Give a task its own Git working copy, containers, and data. Open the preview, inspect the changes, and decide what happens next.

**Bring your task board.** Start with GrigDesk tasks or install the Bitrix24 and Jira drivers. Collect requests from Telegram and GitHub Issues, or draft tasks from meeting recordings.

Run GrigDesk on your Linux machine and connect locally, from another computer, or from your phone.

## Install

**[Download the installer →](https://github.com/EvilDevRu/grigdesk/releases/latest/download/grigdesk-install)**

Save `grigdesk-install`, open a terminal in the same folder, and run:

```bash
chmod +x grigdesk-install
./grigdesk-install install local
```

This installs the desktop app and a local server in your user account. No source checkout, system Node.js, or npm is needed.

**Requirements:** Linux x64 · glibc 2.28+ · FUSE 2 for the desktop app.<br>
Set up your AI agent CLIs and sign-in separately.

<details>
<summary><strong>Remote client, headless server, or .deb package</strong></summary>

Use the same installer for another setup:

| Another setup | Command |
| :--- | :--- |
| Desktop client for a remote server | `./grigdesk-install install remote` |
| Headless server | `./grigdesk-install install server` |

A `.deb` package is also available in [releases](https://github.com/EvilDevRu/grigdesk/releases/latest).

</details>

[Installation guide](docs/grigdesk/guide/installation.md) ·
[First launch](docs/grigdesk/guide/getting-started.md)

## Plugins

Make the workspace your own with extra tools and panels. Open **Settings → Plugins** to browse the catalog, or install a specific release from Git.

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/images/readme/studio3d.png" width="40" height="40" alt="">
      <h3>Studio3D</h3>
      <p>Generate, import, organize, preview, and export 3D models.</p>
      <a href="https://github.com/EvilDevRu/grigdesk-studio3d">Explore Studio3D →</a>
    </td>
    <td width="50%" valign="top">
      <img src="docs/images/readme/codex-reset.png" width="40" height="40" alt="">
      <h3>Codex Reset</h3>
      <p>Public Codex quota reset data and forecasts from codexreset.org, in your usage panel.</p>
      <a href="https://github.com/EvilDevRu/grigdesk-codex-reset">Explore Codex Reset →</a>
    </td>
  </tr>
</table>

[Install a plugin](docs/grigdesk/guide/plugins.md) · [Build your own](docs/grigdesk/plugins/author-contract.md) · [Example plugin](packages/plugin-types/example/README.md)

## Documentation

The [user guide](docs/grigdesk/guide/README.md) covers setup, everyday work, and recovery. It is also built into the app: open **Help** or press **F1**.

| Get started | Build and review |
| :--- | :--- |
| [Installation](docs/grigdesk/guide/installation.md) — set up GrigDesk | [Agent chats](docs/grigdesk/guide/chats.md) — choose models and work with agents |
| [Projects](docs/grigdesk/guide/projects.md) — connect your repositories | [Pipelines](docs/grigdesk/guide/pipelines.md) — move a task through its stages |
| [Tasks](docs/grigdesk/guide/tasks.md) — boards, creation, and triage | [Approval points](docs/grigdesk/guide/gates.md) — inspect results and decide |

Detailed guides are currently in Russian. For help, see [troubleshooting](docs/grigdesk/guide/troubleshooting.md); for architecture and development references, open the [documentation index](docs/README.md).

## Contributing

Bug reports and ideas are welcome in [GitHub Issues](https://github.com/EvilDevRu/grigdesk/issues). Read the [contribution guidelines](CONTRIBUTING.md) before sending changes.

## License

[MIT](LICENSE) © Dmitry Yurchenko.
