<div align="center">
  <h1>dsh-task-reminder</h1>
  <p>Conversation task-completion reminders for the DeepSeek Harness Web UI</p>

  [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
  [![Platform](https://img.shields.io/badge/Platform-DeepSeek%20Harness-lightgrey)](https://github.com/deepseek-ai)
  [![Stars](https://img.shields.io/github/stars/hawkongz/dsh-task-reminder)](https://github.com/hawkongz/dsh-task-reminder/stargazers)

  <p><strong>Language:</strong> <a href="README.md">English</a> | <a href="zh-CN/README.md">简体中文</a></p>
</div>

---

## 📋 Table of Contents

- [Features](#-features)
- [Quick Start](#-quick-start)
- [Installation](#-installation)
- [Usage](#-usage)
- [Troubleshooting](#-troubleshooting)
- [Topics](#-topics)
- [Contributing](#-contributing)
- [License](#-license)

---

Agent turns in DeepSeek Harness keep running while you read the news in another
window — and the only signal that a task finished was the session list turning
idle. This plugin turns that moment into a real reminder, without leaving the
browser surface you already use.

When a conversation task finishes while you are **not** looking at the
conversation window, the plugin can remind you three ways: an always-on
reminder card in the bottom-right corner, a synthesized chime, and a system
notification that survives even when the browser is in the background.
Everything is configured on its own settings page and persists across restarts.

The whole plugin lives on the browser side. The host half (`index.js`) is an
empty `apply() {}`, and there are no runtime dependencies — the host ships it
to the page as a client plugin.

## ✨ Features

* **Always-on reminder card:** a bottom-right card (8 px from the corner) shows
  the session name and jumps straight back to it. Width (240–640 px) and height
  (0–400 px, `0` = automatic) are adjustable, with a live sample card on the
  settings page.
* **Four synthesized chimes:** two-tone (classic), rising three-tone, rising
  arpeggio, and soft triangle — generated live with Web Audio, so no audio
  files are shipped. Picking an effect plays it immediately at the current
  volume; there is no separate preview button.
* **Volume scale shifted up by 20:** the displayed value `80` plays as loud as
  `100` used to, and `0` is still silent.
* **System notifications, on by default:** Web Notification API, so the
  reminder is an OS toast you can see while the app is in the background.
  Clicking it brings the window forward and opens the session. The browser
  permission is requested from the settings switch (a user gesture), and a
  denied or unsupported Notification API degrades to a clear hint on the
  settings page instead of failing silently.
* **Dedicated settings page:** `Settings → Task reminder` (no more rows in
  `Settings → General`), with one-click restore defaults.
* **Presence-aware silence:** the reminder stays quiet only while the main
  area shows the conversation window, the tab is visible, and the window has
  focus. Switching panels, switching tabs, or focusing another application all
  count as away — the reminder fires.
* **Dual-channel completion detection with deduplication:** the host-forwarded
  `api-session/status` event and the official session list's own `running` bit
  share one edge table, so one completion never fires twice.
* **All values persist in browser local storage** and survive restarts, so the
  host half needs no settings namespace.

## 🚀 Quick Start

> **What you need:** DeepSeek Harness running with the `web` profile
> (`dsh web`), Node.js 20 or newer (for `npm` and the self-check), and a
> browser you can hard-refresh.

**Step 1 — Open a terminal**

* macOS / Linux: open Terminal.
* Windows: `Win + R`, type `powershell`, press Enter.

**Step 2 — Install the package into your profile**

The plugin resolves by module name, so install it into the profile directory
itself:

```powershell
# Windows (PowerShell)
cd "$env:USERPROFILE\.dsh\profiles\web"
npm install "github:hawkongz/dsh-task-reminder"
```

```bash
# macOS / Linux
cd ~/.dsh/profiles/web
npm install "github:hawkongz/dsh-task-reminder"
```

To install a specific release instead of the default branch, append the tag:
`npm install "github:hawkongz/dsh-task-reminder#v1.2.1"`.

**Step 3 — Register the bundle row**

In a Harness session, call the `plugin_manager` tool with
`action: install_bundle` and
`target: <profile>\node_modules\dsh-task-reminder` (the package you just
installed). Alternatively, add `"dsh-task-reminder"` to the
`dsh.profile.bundles` array in `<profile>\package.json` by hand — the loader
applies the bundle's `cordis.patch.yml` and inserts the `task-reminder` row.

**Step 4 — Restart and verify**

Restart the host (`dsh web`), then hard-refresh the browser (`Ctrl + F5`).
The browser does not hot-read a changed `client.js`, so both steps are
required after every update. Verify the registration:

```powershell
node -e "console.log(require(process.env.USERPROFILE + '/.dsh/profiles/web/package.json').dsh.profile.bundles)"
dsh --profile web --dump-config | Select-String task-reminder
```

> **Done.** Open `Settings → Task reminder`: if the page is there, the plugin
> is live. Run a task in any session, switch to another application, and wait
> for the reminder.

## 📦 Installation

### Prerequisites

* DeepSeek Harness (`dsh web`) with a `web` profile.
* Node.js 20 or newer.
* A browser that supports Web Audio and (optionally) the Notification API.

### Install with npm

```powershell
cd "$env:USERPROFILE\.dsh\profiles\web"
npm install "github:hawkongz/dsh-task-reminder"
```

The package contains everything the plugin needs: `index.js` (host half),
`client.js` (browser half), `cordis.patch.yml` (the bundle row), and the
self-check under `test/`.

### Uninstall

```powershell
cd "$env:USERPROFILE\.dsh\profiles\web"
npm uninstall dsh-task-reminder
```

Then disable the row with the `plugin_manager` tool
(`action: set_bundle`, `target: dsh-task-reminder`, `enabled: false`), or
remove `"dsh-task-reminder"` from `dsh.profile.bundles`, and restart `dsh web`.

### Local development install

To work on a checkout instead of the published package, point the profile at
your working copy:

```powershell
cd "$env:USERPROFILE\.dsh\profiles\web"
npm install "C:\path\to\dsh-task-reminder"
```

Remember the restart rule: edit `client.js`, run `node test/verify-client.mjs`,
restart `dsh web`, hard-refresh the browser.

## 📖 Usage

### Settings page

`Settings → Task reminder` (settings navigation order 44):

| Setting | Default | Persist key |
| :--- | :--- | :--- |
| System notification | On | `dsh.task-reminder.notify` |
| Completion sound | On | `dsh.task-reminder.sound` |
| Chime effect (four options) | Two-tone (classic) | `dsh.task-reminder.sound-choice` |
| Chime volume (0–100) | 80 | `dsh.task-reminder.volume` |
| Card width (240–640 px) | 420 | `dsh.task-reminder.width` |
| Card height (0–400 px, 0 = automatic) | 0 | `dsh.task-reminder.height` |

Below the rows sits a live card preview that follows the width and height
settings, and a restore-defaults button that writes back: notification on,
sound on, first effect, volume 80, width 420 px, automatic height.

### Browser console helpers

In the browser DevTools console:

```js
// Panel state, the six settings, notification permission, current cards,
// per-session running records, channel counters and the last completion source
__dshTaskReminder.state()

// Pop a card right away and play the chime (does not wait for a task)
__dshTaskReminder.test()

// Play the selected effect at the current volume only
__dshTaskReminder.sound()
```

### Self-check

```bash
node test/verify-client.mjs
```

Runs the browser half under stubbed services (no browser needed) and asserts
the module identity, the wiring, the edge detection, both deduplication
channels, presence-aware silence, the six settings' defaults / read / write /
restore, the oscillator parameters for every effect and volume, the card and
preview styles, all three notification permission paths, and disposal.

## 🔧 Troubleshooting

* **The settings page is missing.** The plugin declares
  `@deepseek-ai/dsh-client-ui-settings` in `dsh.client.inject`; make sure the
  installation completed, then restart `dsh web` and hard-refresh. If the page
  still does not appear, re-register the bundle with the `plugin_manager` tool.
* **Code changes have no effect.** The host reads client plugins only at
  process start and the browser caches the old bundle. Restart `dsh web`,
  then hard-refresh (`Ctrl + F5`).
* **No system notification appears.** Check `__dshTaskReminder.state()`:
  `notificationSupported` must be `true` and `notificationPermission` must be
  `granted`. If the permission is `denied`, allow notifications for the site
  in the browser's address-bar site settings and toggle the switch again.
* **The chime is silent.** The volume may be `0`, or the browser's autoplay
  policy blocked the AudioContext before your first interaction. Interact with
  the page once (any click), then it plays.
* **A reminder fires while you are watching the conversation.** All three
  conditions must hold for silence: the main area is the conversation window,
  the tab is visible, and the window has focus. If the panel hook is missing
  the plugin warns once in the console and treats you as away by design.

## 📌 Topics

[`dsh`](https://github.com/topics/dsh) [`deepseek-harness`](https://github.com/topics/deepseek-harness) [`cordis`](https://github.com/topics/cordis) [`cordis-plugin`](https://github.com/topics/cordis-plugin) [`web-ui`](https://github.com/topics/web-ui) [`notification`](https://github.com/topics/notification) [`reminder`](https://github.com/topics/reminder) [`web-audio`](https://github.com/topics/web-audio)

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## 📄 License

Licensed under the [MIT](LICENSE) License.
