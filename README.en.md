<div align="center">
  <h1>dsh-task-reminder</h1>
  <p>The task is done — stop watching that light in the sidebar<br/>Conversation task reminders for DeepSeek Harness (Web and Desktop): one Windows toast + one chime</p>

  [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
  [![Platform](https://img.shields.io/badge/Platform-DeepSeek%20Harness-lightgrey)](https://github.com/deepseek-ai)
  [![Stars](https://img.shields.io/github/stars/hawkongz/dsh-task-reminder)](https://github.com/hawkongz/dsh-task-reminder/stargazers)
  [![npm](https://img.shields.io/npm/v/@hawkongz/dsh-task-reminder)](https://www.npmjs.com/package/@hawkongz/dsh-task-reminder)
  [![npm downloads](https://img.shields.io/npm/dt/@hawkongz/dsh-task-reminder)](https://www.npmjs.com/package/@hawkongz/dsh-task-reminder)

  <p><strong>Language:</strong> <a href="README.md">简体中文</a> | English</p>
</div>

---

## Table of contents

- [What this is](#what-this-is)
- [Quick start in 30 seconds](#quick-start-in-30-seconds)
- [What you will see](#what-you-will-see)
- [Settings at a glance](#settings-at-a-glance)
- [Desktop (DSH Desktop)](#desktop-dsh-desktop)
- [FAQ](#faq)
- [Advanced](#advanced)
- [Installation details](#installation-details)
- [Development and documentation](#development-and-documentation)
- [License](#license)

---

## What this is

An agent turn in DeepSeek Harness often runs for several minutes. While it does, you switch to another window to get things done — and the only signal that the task stopped is the running light in the sidebar going out. That light does not tell you whether the task finished cleanly or stopped with an error, and it certainly does not tell you that **the agent is stuck on a question waiting for your answer**; if you do not switch back, it just keeps waiting.

This plugin turns that moment into a real reminder: the moment a task stops it sends a **Windows system toast** (the native notification in the bottom-right corner of your OS — visible even with the browser in the background) and plays a synthesized chime. One click on the toast takes you back to that session, **landed at your last question** — you just keep reading.

All three stop reasons are covered, and **one stop is reported once, with the error taking precedence**: a completion alert never fights an error alert, and a Stop you pressed yourself is never misreported as a completion. Everything is configured on its own settings page; changes save automatically and survive restarts.

Zero runtime dependencies: the reminder logic runs entirely on the browser side, and the host half only does the two things a page cannot (raising the app window when you click a toast in the desktop app, and the update check on the settings page). Why it is built that way and how the edge cases are handled is written up in [docs/how-it-works.md](docs/how-it-works.md).

## Quick start in 30 seconds

> **What you need:** DeepSeek Harness running with the `web` profile (`dsh web`), pnpm on your `PATH` (the `dsh plugin` command forwards to it), and a browser you can hard-refresh.

**Step 1 — Install**

```powershell
# Windows (PowerShell), run it from any directory
dsh plugin --profile web add @hawkongz/dsh-task-reminder
```

```bash
# macOS / Linux
dsh plugin --profile web add @hawkongz/dsh-task-reminder
```

**Step 2 — Restart the host, then hard-refresh the browser**

```bash
dsh web
```

Neither step is optional after changing a plugin: the host reads plugins only at process start, and the browser caches the old files.

**Step 3 — Allow notifications**

Open **Settings → Task reminder** — if the page is there, the plugin is live. On the first load the browser asks once for notification permission: choose **Allow**. Missed it at the time? The **Request notification permission** button under the **System toast** row asks again.

Then run a task in any session and wait for the reminder: the default **Always** mode toasts even while you are watching the conversation.

**Desktop** (DSH Desktop, the Electron app) swaps `web` for `desktop`; quit the app completely and open it again after installing (there is no hard-refresh step on the desktop):

```powershell
dsh plugin --profile desktop add @hawkongz/dsh-task-reminder
```

## What you will see

### Task complete

Title **Task complete**, the body is the name of that session. Click the toast to return to the session at your last question.

![A real "Task complete" toast](https://raw.githubusercontent.com/hawkongz/dsh-task-reminder/main/docs/images/toast-completed.en.png)

<sub>A real toast (DSH Desktop, dark theme): app name, title and body.</sub>

### The agent stops and waits for you

When the agent is stuck waiting on you, the title depends on what it is waiting for:

| What it is waiting for | Toast title |
| :--- | :--- |
| Approving an action | **Approval request** |
| Answering a question | **Question** |
| Confirming a plan | **Plan review** |
| A kind it cannot identify | **Waiting for your answer** |

**An approval toast carries Approve / Reject buttons** (see below): one click is exactly **Allow once / Reject** on the in-page approval card, with no switching back to the page; and deciding from the toast **never drags the window to the foreground**. This needs Service Worker support from the browser: plain browser contexts work on `http://127.0.0.1` and `https`; DSH Desktop (`dsh-app://`) and LAN http cannot, so the approval toast falls back to the plain buttonless form and the settings page says so honestly.

![A real approval toast with Approve / Reject](https://raw.githubusercontent.com/hawkongz/dsh-task-reminder/main/docs/images/toast-approval.en.png)

<sub>A real toast in a browser context: the two buttons are the approval card's Allow once / Reject.</sub>

A waiting-class toast closes itself once you have answered or decided, so the notification center never keeps a stale entry that does nothing when clicked.

### Error stop

Title **Task stopped with an error**, the body is the gateway's own message (for example `400 Bad Request`). That stop does not also raise a "Task complete" toast.

### Clicking a toast

- opens the matching session;
- aligns **your last question** to the top of the viewport — not the bottom of the conversation, so you keep reading downward;
- in the desktop app, if the window was minimized or hidden in the tray, it **brings the window to the foreground first** (see [Desktop](#desktop-dsh-desktop)).

### The chime

It sounds on every stop, whatever toast timing you picked: four effects synthesized on the spot (Two-tone (classic) / Rising three-tone / Rising arpeggio / Soft triangle), or an audio file you upload yourself.

### One reminder per stop

The plugin reads the session's own log to tell whether a stop was a completion, an error or a cancel: duplicate signals (the same stop arriving twice by different paths) are dropped, a cancelled turn is not reported, and a failed turn reports only the error. The classification and the edge cases are written up in [docs/how-it-works.md](docs/how-it-works.md).

## Settings at a glance

**Settings → Task reminder** is a page of its own:

| Setting | Default | What it does |
| :--- | :--- | :--- |
| System toast | On | Turn it off and you get the chime only, with no system notification |
| Toast timing | Always | The other option is "Only when unfocused" |
| Notification language | Follows the interface | Affects the toast copy only (title, body, buttons); the settings page always follows the interface language |
| Subagent reminders | Off | Subagent stops do not disturb you by default; turn it on and their completions / waits / errors are announced too |
| Keep notifications on screen | Off | The banner no longer slides into the notification center on its own — you dismiss it yourself |
| Completion sound | On | Turn it off for complete silence |
| Chime effect | Two-tone (classic) | Four synthesized effects, plus "Custom" (an audio file you upload) |
| Custom chime | none | Audio from this machine, stored in your own browser, never uploaded |
| Chime volume | 80 | 0–100, 0 mutes it |

**Restore defaults** writes the defaults above back in one click; an uploaded custom chime file is kept, and to delete it use **Clear** on the **Custom chime** row.

The two **Toast timing** modes:

- **Always** (the default): a toast whenever a task stops, whether you are in another window or watching the conversation;
- **Only when unfocused**: only when you switched the tab away or the browser window lost focus (you are in another app).

Why **Subagent reminders** is off by default: the subagents a lead spawns each run in their own sessions, so one turn can easily chime several times while the conversation you are actually waiting on is still running. The session you are watching reports its own completion, so leaving this off does not lose anything you were waiting for; forked sessions remind you as usual. Turn the switch on to cover the subagents too.

Why **Keep notifications on screen** exists: Windows has a behaviour where a banner that was never clicked may never deliver that click to the page — which showed up as "I clicked the notification and nothing happened". Switch it on and the banner stays until you click it, so the click is guaranteed to arrive; the cost is that you close every notification yourself.

![A toast that stays on screen](https://raw.githubusercontent.com/hawkongz/dsh-task-reminder/main/docs/images/toast-keep-on-screen.en.png)

<sub>A real toast: one that stays does not slide into the notification center on its own — you dismiss it yourself.</sub>

## Desktop (DSH Desktop)

Reminders behave exactly as they do in the browser; the desktop app adds one thing only the main process can do: **raising the window when you click a toast**.

`window.focus()` in the page does nothing for a window that is minimized or hidden in the tray, so on a toast click the page asks the host half to trigger the app's own window activation once, restoring it to the foreground and focusing it. When raising the window it **stops the moment it confirms the window is already in the foreground** instead of fighting for it over and over: a successful click costs at most about 0.7 seconds of attempts rather than pulling you back out of another app again and again over several seconds; if the window is already in front, it does not even try.

See the `--profile desktop` line in [Quick start](#quick-start-in-30-seconds) for the install command.

## FAQ

**No toast?** Walk the chain, cheapest check first:

1. Run `__dshTaskReminder.state()` in the console: `notificationSupported` must be `true`, `notificationPermission` must be `granted`, and `stats.notifications` must count up after each completion. If the counter moves, the browser has accepted the notification — the loss is on the OS display side, not in the plugin.
2. Permission still `default`: the settings page has a **Request notification permission** button under the **System toast** row — click it once and choose Allow. If it is already `denied`, that row deliberately offers no button (no nagging a site that already refused): allow notifications for this site in the browser's address-bar site permissions and the hint clears as soon as permission changes; set the site back to "Ask" and the button reappears. Permission is per origin — granting it for this site once covers every plugin on it.
3. The browser accepted it but nothing is on screen: Windows is suppressing browser notifications. Check Settings → System → Notifications (the master switch **and** the per-app switch for your browser), set Do not disturb to off, then press `Win + N` to open the notification center — the toast may already be sitting there.
4. Ten-second isolation test: run `new Notification('DSH test', { body: 'can you see me' })` in the page console. If that one does not show either, Windows / the browser is suppressing it, and no plugin code can get around that.

**No banner while I am watching video or playing a game fullscreen, and leaving fullscreen does not bring it back?** That is Windows, and it has a switch: while a fullscreen app is in the foreground, Windows hides notification banners — **priority notifications included** — so the reminder only lands in the notification center (`Win + N`), and a suppressed banner is never replayed when you exit fullscreen. The switch is Settings → System → Notifications → Do not disturb → "When using an app in fullscreen mode (priority banners are hidden too)": turn it off and banners appear over the fullscreen window. Verified on Windows 11 (build 26200): with it on, that rule binds fullscreen to the "Alarms only" profile and even the apps on your priority list are not let through; with it off the toasts come back at once. The plugin cannot work around this (Web Notification has no way to bypass Do not disturb), but the chime keeps sounding and the notification keeps waiting in the notification center.

**The chime is silent.** The volume may be 0, the tab may be muted, or the browser's autoplay policy is holding the audio until your first interaction — click or press a key anywhere on the page once and it will sound afterwards.

**The first chime of a browsing session is a few seconds late.** Chrome's first audio rendering has to start the OS audio device (3–5 seconds on some Windows machines), and the autoplay policy only allows that start from a user gesture — every website pays this cost. The habit that avoids it: click once inside the page after opening it (the plugin already queued a silent primer at load, so the device has the whole page load to start); by the time you switch effects or a task finishes, the device is warm and the chime is immediate.

**It still toasts while I am watching the conversation.** That is the **Always** timing mode doing its job. Switch **Toast timing** on the settings page to **Only when unfocused** and it toasts only when the tab is switched away or the browser window loses focus.

**Why is there no button on the approval toast?** It needs a Service Worker: DSH Desktop (`dsh-app://`) and insecure contexts (LAN http) fall back to a plain toast. Also, all DSH client plugins share the same `/plugins/` scope, so **install only one notification plugin of this kind** — if another plugin that uses the same trick is installed (for example `dsh-notify-me`), the two registrations replace each other and only one of them keeps its toast buttons; installing both also alerts you twice for every stop.

**I clicked the toast but the desktop window did not come back.** Raising the window is host-half behaviour, and the host reads plugins only at process start — a running app still holds the old code. Check that the profile has 1.6.3 or newer (1.4.4 is the minimum version that has this route), then quit the app completely and open it again. A missing route is skipped silently: the session still opens, only the window is not raised.

**A freshly published version will not install (you end up with the previous one).** pnpm 11 enables a one-day cooldown (`minimumReleaseAge` is 1440 minutes) by default, so anything younger cannot be resolved. Pin the version and it installs: `dsh plugin --profile web add @hawkongz/dsh-task-reminder@1.6.3`, or set `minimumReleaseAge: 0` in the profile's `pnpm-workspace.yaml`, or wait a full day.

**Code changes have no effect.** The host reads plugins only at process start, and the browser caches the old files: restart `dsh web` and hard-refresh (`Ctrl + F5`); in the desktop app, quit completely and open it again.

**The settings page is missing.** Restart + hard-refresh; if it is still missing, run the install command again exactly as it is: `dsh plugin --profile web add @hawkongz/dsh-task-reminder`.

## Advanced

### Custom chime (your own audio)

**Settings → Task reminder → Custom chime → Choose file** accepts audio from this machine (mp3 / wav / ogg / m4a — anything the browser can decode, up to 5 MB). Picking a file plays it once right away at the current volume, and every reminder after that uses it.

The audio **lives in your own browser only**: it is not uploaded and does not enter the plugin package, and the host half is not involved at all. It is stored per browser and survives restarts, but "clear site data" or a different browser loses it — pick the file again there, and the row says honestly that the file is gone. **Clear** deletes it and puts the effect back on the first synthesized chime. If it cannot be stored or decoded (private mode, full quota, unsupported codec), the row states the reason and reminders fall back to a synthesized chime instead of going silent.

### Check for updates and one-click upgrade

The bottom row of the settings page shows the current version and one button. The check **asks npm's official registry and the mainland mirror at the same time** and takes the higher version either one answers with — a mirror that has not synced yet cannot turn a real release into "up to date", and if one of them is unreachable you still get the other's answer. Only when both are down does it report a failure honestly.

The upgrade itself is handed to DSH's own plugin manager (not a hand-rolled pnpm command line), and when it is done you are told to restart DSH to load it. Two cases are refused honestly instead of half-done:

- **A local development install** (`link:` / `file:` in the profile): it still tells you a newer release exists, but offers no button that would overwrite your working copy;
- **A composition without the plugin manager**: it says why, and gives you the manual upgrade command.

No uploads and no telemetry: the check is an ordinary version query, and the update is one package install in your own profile.

### Browser console helpers

Want to debug it yourself, or just see what a notification looks like first:

```js
// Current state: notification permission, the eight settings, notification language,
// toast timing, per-session running state, counters and the most recent stops
__dshTaskReminder.state()

// Send a "Task complete" toast right away and play the chime (no need to wait for a stop)
__dshTaskReminder.test()
__dshTaskReminder.test('question')   // the "Question" toast
__dshTaskReminder.test('plan')       // the "Plan review" toast
__dshTaskReminder.test('approval')   // an approval toast with Approve / Reject buttons (reports back only; settles no real request)
__dshTaskReminder.test('error')      // the "Task stopped with an error" toast

// Play the current effect at the current volume only
__dshTaskReminder.sound()

// Skip the toast and jump straight to the session of the most recent reminder
// (splits "did the click arrive" from "does the jump work")
__dshTaskReminder.jump()

// Run the "land at your last question" step again on the session you have open
// (handy for confirming that step still works after a DSH upgrade)
__dshTaskReminder.focusQuestion()

// One line showing how far that landing got last time, plus the live page structure
// it depends on (whichever item turned 0 / null is where it broke)
__dshTaskReminder.report()
```

### Data and privacy

- The eight settings and your custom audio live in **your own browser** only, and survive restarts;
- The plugin uploads nothing and has no telemetry;
- The only thing that goes online is "Check for updates", and only when you click that button (see above).

## Installation details

### Prerequisites

- DeepSeek Harness with the `web` profile (`dsh web`);
- pnpm on your `PATH` — `dsh plugin` forwards its arguments to the pnpm in the profile directory;
- Node.js 20 or newer (needed to run the self-check);
- A browser that supports Web Audio and, preferably, the Notification API.

### What the install command does

One command does two things: it installs the package into the profile directory, and it appends `@hawkongz/dsh-task-reminder` to the profile's plugin list (`dsh.profile.bundles`); the loader then applies the bundle row the package ships — no manual registration. The package carries no build scripts, so pnpm does not block the install.

The package name can only carry a scope: npm judges the bare name `dsh-task-reminder` too similar to the existing package `dsh-taskreminder` and rejects it permanently.

### Pinning a specific version

```powershell
dsh plugin --profile web add @hawkongz/dsh-task-reminder@1.6.3
```

You have to install this way while a new release is younger than pnpm's one-day cooldown (see [FAQ](#faq)). pnpm records that exemption in the profile's `pnpm-workspace.yaml` and installs it right away. To check which version a profile actually has:

```powershell
(Get-Content $env:USERPROFILE\.dsh\profiles\web\node_modules\@hawkongz\dsh-task-reminder\package.json | ConvertFrom-Json).version
```

### Installing from GitHub

```powershell
# default branch
dsh plugin --profile web add github:hawkongz/dsh-task-reminder

# pin a release tag instead of the default branch
dsh plugin --profile web add github:hawkongz/dsh-task-reminder#<tag>
```

### Verifying the install

```powershell
dsh --profile web --dump-config | Select-String task-reminder
```

### Uninstall

```powershell
dsh plugin --profile web remove @hawkongz/dsh-task-reminder
```

`remove` uninstalls the package and tidies that line out of the plugin list; then restart `dsh web` so the composed config takes effect.

### What is in the package

`index.js` (host half), `client.js` (browser half), `cordis.patch.yml` (the plugin row), the self-check under `test/`, and the documentation.

## Development and documentation

- Implementation details (why it is built this way, edge cases, internals): [docs/how-it-works.md](docs/how-it-works.md)
- Version history: [CHANGELOG.md](CHANGELOG.md)
- Contributing, local development and the self-check: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security: [SECURITY.md](SECURITY.md)
- License: [LICENSE](LICENSE)

GitHub topics: [`dsh`](https://github.com/topics/dsh) [`deepseek-harness`](https://github.com/topics/deepseek-harness) [`cordis`](https://github.com/topics/cordis) [`cordis-plugin`](https://github.com/topics/cordis-plugin) [`web-ui`](https://github.com/topics/web-ui) [`notification`](https://github.com/topics/notification) [`reminder`](https://github.com/topics/reminder) [`web-audio`](https://github.com/topics/web-audio)

## License

Open source under the [MIT](LICENSE) license.
