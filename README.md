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

When a conversation task stops, the plugin sends a **Windows system
toast** (Web Notification — the native notification in the bottom-right corner
of your OS, visible while the browser is in the background; click it to return
to that session) and plays a synthesized chime. Three stop reasons are
covered: **task complete**, **the agent is waiting for your answer**
(`ask_user_question` pending), and **an error stop** (a red error such as
400) — one stop is reported once, with the error taking precedence. The toast
timing has two modes: **Always** (every completion, no matter whether the
browser window is in the foreground) or **Only when unfocused** (when you
switch the tab away or the browser window loses focus). There is no in-app
card: the OS toast is the only visual channel. Everything is configured on its
own settings page and persists across restarts.

The whole plugin lives on the browser side. The host half (`index.js`) is an
empty `apply() {}`, and there are no runtime dependencies — the host ships it
to the page as a client plugin.

## ✨ Features

* **Windows system toast as the single visual channel:** Web Notification API,
  an OS toast you can see while the app is in the background. Clicking it
  brings the window forward and opens the session. Three stop reasons are
  covered: **task complete**, **waiting for your answer** (the agent blocked
  in `ask_user_question` / plan review — detected by reading the read-only
  `uiSession.sessionStatus` snapshot, never by joining the question waterfall),
  and **error stop** (`api-session/error`, e.g. a red 400). One stop is
  reported once, error first: the completion toast waits out a short merge
  window and stands down when an error for the same stop arrives.
  Two timing modes — **Always** (every stop) or **Only when unfocused**
  (tab switched away or window unfocused) — pick one on the settings page. The
  browser asks for notification permission once on the first load — the
  Notification API has no permission-free path, which is why in-page-only
  plugins never show such a prompt. If the permission was reset afterwards, a
  **Request notification permission** button under the System toast row
  re-asks. A denied or unsupported Notification API degrades to a clear hint
  on the settings page instead of failing silently.
* **Four synthesized chimes:** two-tone (classic), rising three-tone, rising
  arpeggio, and soft triangle — generated live with Web Audio, so no audio
  files are shipped. Picking an effect plays it immediately at the current
  volume; there is no separate preview button. The chime sounds on every stop,
  whatever the toast timing mode.
* **Dedicated settings page:** `Settings → Task reminder` (no more rows in
  `Settings → General`), with one-click restore defaults.
* **Dual-channel completion detection with deduplication:** the host-forwarded
  `api-session/status` event and the official session list's own `running` bit
  share one edge table, so one completion never fires twice.
* **All values persist in browser local storage** and survive restarts, so the
  host half needs no settings namespace.

## 🚀 Quick Start

> **What you need:** DeepSeek Harness running with the `web` profile
> (`dsh web`), pnpm on your `PATH` (the `dsh plugin` command forwards to it),
> and a browser you can hard-refresh.

**Step 1 — Open a terminal**

* macOS / Linux: open Terminal.
* Windows: `Win + R`, type `powershell`, press Enter.

**Step 2 — Install and register with one command**

`dsh plugin` installs the package into the profile directory and appends the
bundle to the profile's `dsh.profile.bundles` in a single step — no manual
registration:

```powershell
# Windows (PowerShell) — run it from any directory
dsh plugin --profile web add github:hawkongz/dsh-task-reminder
```

```bash
# macOS / Linux
dsh plugin --profile web add github:hawkongz/dsh-task-reminder
```

To pin a release instead of the default branch, append the tag:
`dsh plugin --profile web add github:hawkongz/dsh-task-reminder#v1.3.0`.
Once the package is published to the npm registry, the bare name works the
same way: `dsh plugin --profile web add dsh-task-reminder`.

**Step 3 — Restart and verify**

Restart the host (`dsh web`), then hard-refresh the browser (`Ctrl + F5`).
The browser does not hot-read a changed `client.js`, so both steps are
required after every update. Verify the registration:

```powershell
dsh --profile web --dump-config | Select-String task-reminder
```

> **Done.** Open `Settings → Task reminder`: if the page is there, the plugin
> is live. On the first load the browser shows a one-time
> notification-permission prompt — choose **Allow** and the system toast is
> set. Run a task in any session and wait for the reminder — in the default
> **Always** mode the toast fires even while you watch the conversation.

## 📦 Installation

### Prerequisites

* DeepSeek Harness (`dsh web`) with a `web` profile.
* pnpm on your `PATH` — `dsh plugin` forwards its arguments to pnpm inside the
  profile directory.
* Node.js 20 or newer (for the self-check).
* A browser that supports Web Audio and (optionally) the Notification API.

### Install with dsh plugin

```powershell
dsh plugin --profile web add github:hawkongz/dsh-task-reminder
```

This installs the package into the profile and appends `dsh-task-reminder` to
the profile's `dsh.profile.bundles`; the loader then applies the bundle's
`cordis.patch.yml` and inserts the `task-reminder` row. The package ships no
build scripts, so pnpm never blocks the install (unlike git-hosted packages
that need an `allowBuilds` entry in the profile's `pnpm-workspace.yaml`).

The package contains everything the plugin needs: `index.js` (host half),
`client.js` (browser half), `cordis.patch.yml` (the bundle row), and the
self-check under `test/`.

### Uninstall

```powershell
dsh plugin --profile web remove dsh-task-reminder
```

The `remove` drops the package and reconciles the bundle list in one step.
Then restart `dsh web` so the row leaves the composed config.

### Local development install

To iterate on a checkout instead of the published package, link it into the
profile (this is what the `plugin_manager` tool's `install_bundle` action
creates internally):

```powershell
# Windows (PowerShell) — from the directory that contains the checkout
dsh plugin --profile web add link:.\dsh-task-reminder

# or with an absolute path, from anywhere
dsh plugin --profile web add link:C:\Users\20105\OneDrive\Desktop\ds\dsh-task-reminder
```

Remember the restart rule: edit `client.js`, run `node test/verify-client.mjs`,
restart `dsh web`, hard-refresh the browser — the host does not hot-read a
changed `client.js`.

## 📖 Usage

### Settings page

`Settings → Task reminder` (settings navigation order 44):

| Setting | Default | Persist key |
| :--- | :--- | :--- |
| System toast | On | `dsh.task-reminder.notify` |
| Toast timing (Always / Only when unfocused) | Always | `dsh.task-reminder.notify-mode` |
| Completion sound | On | `dsh.task-reminder.sound` |
| Chime effect (four options) | Two-tone (classic) | `dsh.task-reminder.sound-choice` |
| Chime volume (0–100) | 80 | `dsh.task-reminder.volume` |

A restore-defaults button writes back: toast on (Always), sound on, first
effect, volume 80.

### Browser console helpers

In the browser DevTools console:

```js
// Window focus state, the five settings, toast timing, notification
// permission, per-session running records, channel counters and the last
// stop of each kind
__dshTaskReminder.state()

// Send a task-complete toast right away and play the chime (does not wait for a task)
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
channels, the two toast timing modes, the three stop reasons (completion,
pending question, error) with the error-first merge for one stop, the chime
sounding on every stop regardless of window state, the five settings'
defaults / read / write / restore, the oscillator parameters for every effect
and volume, all notification permission paths plus the in-page
permission-request button, the suspended-AudioContext revival on a user
gesture, and disposal.

## 🔧 Troubleshooting

* **The settings page is missing.** The plugin declares
  `@deepseek-ai/dsh-client-ui-settings` in `dsh.client.inject`; make sure the
  installation completed, then restart `dsh web` and hard-refresh. If the page
  still does not appear, re-run
  `dsh plugin --profile web add github:hawkongz/dsh-task-reminder`.
* **Code changes have no effect.** The host reads client plugins only at
  process start and the browser caches the old bundle. Restart `dsh web`,
  then hard-refresh (`Ctrl + F5`).
* **No system toast appears.** Walk the chain, cheapest check first:
  1. `__dshTaskReminder.state()` — `notificationSupported` must be `true`,
     `notificationPermission` must be `granted`, and `stats.notifications`
     must count up after each completion (`1` means the browser accepted the
     toast; the loss is then on the OS side, not in the plugin).
  2. Permission still `default`? The settings page shows a **Request
     notification permission** button under the System toast row — click it
     once and choose Allow. Permission `denied`? Allow notifications for the
     site in the browser's address-bar site settings, then click the button
     again. Permission is per origin — granting it for this app once covers
     every plugin on it.
  3. Browser accepted but nothing shows on screen? Windows is suppressing
     browser toasts. Check: Settings → System → Notifications (master switch
     **and** the per-app switch for your browser), Focus assist set to
     **Off** ("Priority only" hides ordinary toasts), and open the
     notification center with `Win + N` — the toast may have landed there
     unnoticed.
  4. Ten-second isolation test — run `new Notification('DSH test', { body: 'can
     you see me' })` in the page console. If that toast is invisible too, the
     suppression is on the Windows/browser side and no plugin code can fix it.
* **The chime is silent.** The volume may be `0`, the browser tab may be muted,
  or the autoplay policy keeps the AudioContext suspended until your first
  interaction — click or type anywhere in the page once, then it plays.
* **The first chime of a browser session is delayed by a few seconds.** The
  first audio rendering inside Chrome starts the OS audio device (3-5 s on
  some Windows machines), and the autoplay policy allows that start only from
  a user gesture — no in-page code can start audio before one, so every
  website shares this cost. The habit that removes it: after opening the page,
  click anywhere in it once (the plugin resumes the context and plays a silent
  primer on that first gesture); by the time you switch an effect or a task
  finishes, the device is warm and the chime is immediate.
* **A toast fires while you watch the conversation.** That is the **Always**
  timing mode doing its job. Switch the Toast timing row to **Only when
  unfocused** and the toast fires only when the tab is switched away or the
  browser window loses focus.

## 📌 Topics

[`dsh`](https://github.com/topics/dsh) [`deepseek-harness`](https://github.com/topics/deepseek-harness) [`cordis`](https://github.com/topics/cordis) [`cordis-plugin`](https://github.com/topics/cordis-plugin) [`web-ui`](https://github.com/topics/web-ui) [`notification`](https://github.com/topics/notification) [`reminder`](https://github.com/topics/reminder) [`web-audio`](https://github.com/topics/web-audio)

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## 📄 License

Licensed under the [MIT](LICENSE) License.
