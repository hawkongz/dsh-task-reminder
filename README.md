<div align="center">
  <h1>dsh-task-reminder</h1>
  <p>Conversation task-completion reminders for DeepSeek Harness (Web UI and Desktop)</p>

  [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
  [![Platform](https://img.shields.io/badge/Platform-DeepSeek%20Harness-lightgrey)](https://github.com/deepseek-ai)
  [![Stars](https://img.shields.io/github/stars/hawkongz/dsh-task-reminder)](https://github.com/hawkongz/dsh-task-reminder/stargazers)
  [![npm](https://img.shields.io/npm/v/@hawkongz/dsh-task-reminder)](https://www.npmjs.com/package/@hawkongz/dsh-task-reminder)
  [![npm downloads](https://img.shields.io/npm/dt/@hawkongz/dsh-task-reminder)](https://www.npmjs.com/package/@hawkongz/dsh-task-reminder)

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
to that session **at your last question**) and plays a synthesized chime. Three stop reasons are
covered: **task complete**, **the agent is waiting for your answer**
(`ask_user_question` pending), and **an error stop** (any failed turn — a
gateway HTTP error such as 400 / 401 / 429 / 500 / 502, a provider outage, or
a connection failure) — one stop is reported once, with the error taking
precedence. The toast
timing has two modes: **Always** (every completion, no matter whether the
browser window is in the foreground) or **Only when unfocused** (when you
switch the tab away or the browser window loses focus). There is no in-app
card: the OS toast is the only visual channel. Everything is configured on its
own settings page and persists across restarts.

The reminder logic all lives on the browser side — the host half (`index.js`)
adds exactly two things and nothing else. First, inside DSH Desktop only:
**raising the app window when you click a toast**. An Electron renderer cannot
pull back a window that is minimized or hidden in the tray, so on a toast click
the page asks the host half (a `POST` to `api/task-reminder/window-activation`,
a Connection exact-Fetch route) to relaunch the app once: the second process
cannot take the single-instance lock, exits at once, and the running app handles
`second-instance` → `focusPrimaryWindow()`. Outside DSH Desktop nothing calls the
route, and if something did it would just answer 501.

Second, for everyone: the two routes behind the settings page's **Check for
updates** entry — one reads the latest published version from npm, the other
upgrades the installed package through DSH's own plugin manager. Nothing about
reminding depends on either route; without a web server they are simply not
registered.

## ✨ Features

* **Windows system toast as the single visual channel:** Web Notification API,
  an OS toast you can see while the app is in the background. Clicking it
  brings the window forward, opens the session **and lands at your last
  question** — reading then runs downward from it, the way you actually read —
  `window.focus()` in a browser, and in DSH Desktop the host
  half raises the minimized or tray-hidden app window (see
  [DSH Desktop](#dsh-desktop-clicking-a-toast-raises-the-app-window)). DSH
  exposes no scroll API (`openSession(target)` takes no options,
  `ctx.uiConversation` has no navigation surface, and the Chat view's own
  scrolling is not exported by the package), so the plugin does what a reader
  would: right after opening, it aligns the last row of **your own messages**
  (`[data-chat-flow-kind="user"]` / `"steering"` inside the transcript's
  `[data-chat-flow]` column) to the top of the conversation scrollport, 24 px
  down — the exact landing the app's own *jump to turn N* uses. It keeps
  checking for a couple of ticks because the app's own scroll restore can land
  after the first try, and a direction that cannot scroll any further (top or
  bottom) counts as aligned so no extra pixels are added on every tick. The
  transcript is only touched once the mounted `data-conversation-session` is the
  session that was just opened, so a still-switching view is left alone. All
  three toast kinds land this way, approvals included. A changed DOM can only
  lose this extra step, never the session opening;
  `state().stats.lastQuestionJump` records which outcome happened
  (`aligned` / `no-column` / `other-session` / `no-question` / `no-scroller` /
  `timeout`).
  Three stop reasons are
  covered: **task complete**, **the agent waiting on you** (one title per
  pending kind — **approval request**, **question**, **plan review** — detected
  by reading the read-only `uiSession.sessionStatus` snapshot, never by joining
  the question waterfall), and **error stop** (`api-session/error` — any failed
  turn: a gateway HTTP error such as 400 / 401 / 429 / 500 / 502, a provider
  outage, or a transport failure). An **approval toast carries 同意 / 拒绝
  (Approve / Reject) buttons**: one click settles the request through the
  approval's own `answer('allowed-once' | 'rejected')` — the exact verb the
  in-page approval card uses — so you never switch back to the page to decide.
  Its body is **tool: reason** — the host's localized `displayReason` resolved in the notification language, falling back to the raw `reason`; only an approval with neither falls back to the session name (since 1.6.1; before that the body always showed the session name and said nothing about what was being approved).
  Buttons need a Service Worker; see
  [Quick decisions](#quick-decisions-from-the-toast). Toast tags are independent
  per notification (the 1.5.5 behaviour, restored in 1.6.2): a newer toast never
  replaces an older one. Fixed-per-kind tags with `renotify` looked tidier, but
  Windows then replaces the previous banner — and the replaced entry cannot be
  clicked any more in the Action Center (Electron on Windows does not deliver a
  click for a notification-center entry, electron#29461), which showed up as
  "clicking the toast does not raise the window".
  One stop is
  reported once, error first: when a stop arrives, the plugin classifies it
  from the session's durable log (the `turn/end` reason) — a completed turn
  (or one that hit its output ceiling) reports completion, a failed turn
  reports the error with the gateway's own message and never a completion
  toast, and a cancelled turn reports nothing. The classification read also
  takes the last `turn/start`: while the newest turn is still open (that
  `turn/end` belongs to the previous turn), the plugin retries until it
  lands — pressing Stop is never misreported as a completion. The chime and
  the toast go out together in the same pass. If classification is
  unavailable, the completion toast goes out at once and a same-stop error
  arriving within 5 s retracts it — error first, one reminder per stop.
  "The same stop" is decided by **turn number**, not by a clock: the
  classification also returns the `turn/end`'s `data.turn` and each session
  remembers the last turn it settled, so a repeated edge for that turn (a
  duplicate channel, a stale list replay) is dropped deterministically, while
  a *new* turn that completes within 5 s of the previous stop still reminds
  you — the old time window alone muted exactly that case on DSH Desktop,
  where the host-forwarded event channel is sparse and nothing clears the
  last ticket. The 5 s window is kept only for the error-first directions
  (`error → completion` suppressed, `completion → error` retraction) and as
  the fallback when no turn number can be read (`api-session/error` carries
  none, and neither does a stop the fallback path had to report on its own —
  a replay of that stop is still window-guarded on purpose: missing a new turn
  inside those 5 s is the cheaper mistake than a duplicate toast). A repeated edge while classification is in flight is held back by
  the in-flight guard and the turn-number check.
  Two timing modes — **Always** (every stop) or **Only when unfocused**
  (tab switched away or window unfocused) — pick one on the settings page. The
  browser asks for notification permission once on the first load — the
  Notification API has no permission-free path, which is why in-page-only
  plugins never show such a prompt. If the permission was reset afterwards, a
  **Request notification permission** button under the System toast row
  re-asks. A denied or unsupported Notification API degrades to a clear hint
  on the settings page instead of failing silently.
* **Subagent sessions are muted by default:** the agents a lead spawns, and the
  ones any other agent spawns, stop in their own sessions — each of those stops
  reaches the plugin as just another `sessionId`, and one turn can easily fire
  several reminders while the conversation you actually asked for is still
  running. They are filtered out of all three detection channels and the error
  event before any of the edge, classification, chime or toast work happens, by
  dropping exactly the list rows whose `origin` is `subagent` (the field the
  official sidebar uses to keep subagent children out of the session list). What
  you lose is nothing: the session you are watching reports its own completion.
  Forked sessions carry a `parentId` but not that origin, so a fork still
  reminds you. A **Subagent reminders** switch on the settings page turns the
  reminders for subagents back on, completions, pending questions and errors
  alike — it is off out of the box and Restore defaults turns it off again.
* **Four synthesized chimes, plus your own audio file:** two-tone (classic),
  rising three-tone, rising arpeggio, and soft triangle — generated live with
  Web Audio, so no audio files are shipped. The fifth option, **Custom**, plays
  an audio file you pick from this machine: the bytes go into the browser's
  IndexedDB (not local storage), are decoded with `decodeAudioData` and played
  through the same volume gain, so nothing is uploaded and nothing enters the
  package. Picking an effect plays it immediately at the current volume; there
  is no separate preview button. If IndexedDB, the file or the decoder is
  unavailable, the reminder falls back to the first synthesized chime instead
  of going silent. The chime sounds on every stop, whatever the toast timing
  mode.
* **Dedicated settings page:** `Settings → Task reminder` (no more rows in
  `Settings → General`), with one-click restore defaults and a **Check for
  updates** entry at the very bottom — the current version, a button that asks
  npm (official registry plus the mainland mirror) for the latest release, and a
  one-click upgrade through DSH's own plugin manager. See
  [Check for updates](#check-for-updates).
* **Three-channel completion detection with deduplication:** the host-forwarded
  `api-session/status` event, the official session list's own `running` bit, and
  the `running` bit inside the `uiSession.sessionStatus` snapshot (the same
  source as the sidebar's running light — the reliable path when a forked
  session's list projection is stale) share one edge table, so one completion
  never fires twice; a repeated edge while classification is in flight is
  additionally held back by the in-flight guard and, once classified, by the
  turn-number check (the same turn is never reported twice, and a new turn is
  never mistaken for a duplicate).
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
dsh plugin --profile web add @hawkongz/dsh-task-reminder
```

```bash
# macOS / Linux
dsh plugin --profile web add @hawkongz/dsh-task-reminder
```

This installs the published package from the npm registry — the same way every
other DSH plugin is installed. (The unscoped name
`dsh-task-reminder` is permanently unavailable: npm rejects it as too similar
to the existing package `dsh-taskreminder`, so the scoped name is the only
registry form.) On DSH Desktop, run the same command with
`--profile desktop` and restart the app — details under
[Installation](#install-with-dsh-plugin).

> **Installing on release day.** pnpm 11 enables `minimumReleaseAge` by default
> (1440 minutes — one day), so a version published today cannot be resolved
> yet: the bare command reports `… 1.5.2 (1.5.4 is available)` and installs the
> previous release. To get today's version, pin it —
> `dsh plugin --profile web add @hawkongz/dsh-task-reminder@1.5.4` (pnpm then
> exempts that exact version) — or set `minimumReleaseAge: 0` in the profile's
> `pnpm-workspace.yaml`, or install a day later. See
> [Troubleshooting](#-troubleshooting) for the same symptom.

To install from the GitHub repository instead — the default branch, or a
pinned release tag — use the `github:` spec:

```powershell
# default branch
dsh plugin --profile web add github:hawkongz/dsh-task-reminder

# pin a release instead of the default branch: append the tag
dsh plugin --profile web add github:hawkongz/dsh-task-reminder#<tag>
```

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
dsh plugin --profile web add @hawkongz/dsh-task-reminder
```

This installs the package into the profile and appends
`@hawkongz/dsh-task-reminder` to the profile's `dsh.profile.bundles` (the row
itself carries the id `task-reminder`); the loader then applies the bundle's
`cordis.patch.yml` and inserts the `task-reminder` row. To install from
GitHub instead, use `github:hawkongz/dsh-task-reminder[#<tag>]`. The package ships no
build scripts, so pnpm never blocks the install (unlike git-hosted packages
that need an `allowBuilds` entry in the profile's `pnpm-workspace.yaml`).

To install one exact release instead of whatever the registry resolves today
(needed while a new version is younger than pnpm 11's one-day
`minimumReleaseAge` cooldown — see above), pin the version:

```powershell
dsh plugin --profile web add @hawkongz/dsh-task-reminder@1.5.4
```

pnpm records that exemption in the profile's `pnpm-workspace.yaml`
(`minimumReleaseAgeExclude`) and installs it right away. Verify what a profile
actually has with:

```powershell
(Get-Content $env:USERPROFILE\.dsh\profiles\web\node_modules\@hawkongz\dsh-task-reminder\package.json | ConvertFrom-Json).version
```

DSH Desktop (the Electron app) runs the same package from its **own** profile —
swap `web` for `desktop`, then restart the desktop app (there is no browser
hard-refresh step there):

```powershell
dsh plugin --profile desktop add @hawkongz/dsh-task-reminder
```

The reminders behave exactly as they do in the browser; the only extra is the
desktop-only window activation described under
[DSH Desktop](#dsh-desktop-clicking-a-toast-raises-the-app-window).

The package contains everything the plugin needs: `index.js` (host half),
`client.js` (browser half), `cordis.patch.yml` (the bundle row), and the
self-check under `test/`.

### Uninstall

```powershell
dsh plugin --profile web remove @hawkongz/dsh-task-reminder
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
| Notification language (Simplified Chinese / English) | Follows the interface | `dsh.task-reminder.notify-language` |
| Subagent reminders | Off | `dsh.task-reminder.subagent` |
| Completion sound | On | `dsh.task-reminder.sound` |
| Chime effect (four synthesized + Custom) | Two-tone (classic) | `dsh.task-reminder.sound-choice` |
| Custom chime file | none | `dsh.task-reminder.custom-sound` (metadata; audio bytes in IndexedDB) |
| Chime volume (0–100) | 80 | `dsh.task-reminder.volume` |

A restore-defaults button writes back: toast on (Always), notification language
following the interface, subagent reminders off, sound on, first effect, volume
80. An uploaded custom chime file is kept — use **Clear** in the Custom chime
row to delete it.

**Toast timing** spells both modes out under the row's title, with the two modes
stacked one above the other so each lines up with its own explanation — readable
without trying them:

* *Always* — toasts as soon as a task finishes, whether or not the browser
  window is in the foreground.
* *Only when unfocused* — toasts after you switch the tab away or the browser
  window loses focus (you are in another app).

**Notification language** has just two options — Simplified Chinese and English;
*follow the interface* is the default rather than a third entry, and the row
shows the language that is actually in effect (the interface language until you
pin one). It affects the toast copy only (title, body, the Approve / Reject
button labels); the settings page itself always follows the interface language,
so pinning English alerts does not turn the page English.

### Check for updates

The last row on the page shows the version you are running and one button:

| State | What the row says | Button |
| :--- | :--- | :--- |
| Not checked yet | `Current version v1.6.0` | **Check for updates** |
| Checking | `Checking for updates…` | disabled |
| Up to date | `Current version v1.6.0; this is the latest release` | **Check for updates** |
| Newer release | `Current version v1.5.5; v1.6.0 is available. Restart DSH after updating` | **Update to v1.6.0** |
| Updating | `Updating to v1.6.0…` | disabled |
| Updated | `Updated to v1.6.0: restart DSH to load it` | **Reload page** |
| Failed | `Update check failed: <reason>` / `Update failed: <reason>. If it did install, restart DSH and trust the version shown` | **Check for updates** |

Updating never guesses. The host half asks **both** npm's official registry and
`registry.npmmirror.com` in parallel and takes the highest version either one
answers with, so a mirror that has not synced yet cannot turn a real release
into "up to date" — and a machine that cannot reach one of them still gets an
answer from the other. Only when *both* fail does the row report a failure
instead of pretending everything is current.

The check also does not depend on a proxy being up. Node 24's `fetch` honors
`HTTPS_PROXY` when `NODE_USE_ENV_PROXY=1`, and with a local proxy that happens to
be switched off (Clash closed, a corporate proxy down) that turns into
`ECONNREFUSED 127.0.0.1:7897` even though the direct route is perfectly fine. So
each registry is asked over **two transports at once**: a direct HTTPS request
(`agent: false`, which opts out of the proxy that Node installs on the global
agent) and, when the environment really enables a proxy, the proxy path. The
first answer wins. A failure message carries the underlying cause (`ECONNREFUSED
…`, `ENOTFOUND …`) instead of undici's bare "fetch failed".

The upgrade itself is handed to **DSH's own plugin manager**
(`pluginManager.installBundle`), not to a hand-rolled `pnpm` command line: that
service knows how this profile starts its package manager (DSH Desktop passes
the app's bundled pnpm through launcher facts), retries the next registry when
one is unreachable, rolls `package.json` and the lockfile back when the install
fails, and reports the outcome. Because the dependency already exists, the
manager returns `restart-required` — it writes the new version to disk and
leaves the running tree alone, which is exactly what you want while the plugin
that asked for the update is itself running in that tree. Restart DSH (or, in a
plain browser, reload the page) and the new version is live.

Two cases are refused honestly rather than half-done:

* **Local development install** (`link:` / `file:` in the profile's
  `package.json`): the row still tells you a newer release exists, but there is
  no button that would replace your working copy with the published package.
* **A composition without the plugin manager**: the row says so and asks you to
  update by hand (`dsh plugin add @hawkongz/dsh-task-reminder@latest`).

Nothing is uploaded and no telemetry is involved: the check is one HTTPS `GET`
for the package's `dist-tags.latest`, and the update is a normal package
install in your own profile.

### Quick decisions from the toast

An **approval** toast carries **同意 / 拒绝** (Approve / Reject) buttons in the
browser. Clicking one runs the same `answer('allowed-once' | 'rejected')` the
in-page approval card runs — "Approve" is *Allow once*, nothing is widened — and
the page never has to come forward: deciding from a toast must not drag the
window up. A wait that is settled elsewhere (the card, another tab) closes its
toast, and a stale toast whose request was replaced decides nothing.

This needs a Service Worker, so the same `client.js` is registered as the
plugin's own worker (the boot graph's single-plugin bundle URL); the worker only
relays which button was clicked. Plain browser contexts work on
`http://127.0.0.1` and `https`. Where a worker cannot run — an insecure LAN
origin, or **DSH Desktop** (`dsh-app://` cannot register a Service Worker) — the
approval toast falls back to its buttonless form and the settings page says so
under the System toast row instead of pretending. Check the live state with
`__dshTaskReminder.state().approvalBridge` (`active` = buttons are on), and send
yourself a buttoned toast with `__dshTaskReminder.test('approval')` (the buttons
report which one you pressed and settle nothing).

One caveat about the worker's scope: every DSH client bundle is served from the
same `/plugins/` route, so the registration lands on the shared `/plugins/`
scope — an origin can only host one such worker. Install a single notification
plugin that uses this trick: if another one (e.g. `dsh-notify-me`) is present,
the two registrations replace each other and only one of them keeps its toast
buttons. Running both plugins also double-alerts every stop.

### Custom chime (your own audio)

`Settings → Task reminder → Custom chime → Choose file` accepts an audio file
(mp3 / wav / ogg / m4a — anything the browser can decode, up to 5 MB). The
plugin stores it in the **IndexedDB** database `dsh.task-reminder` (local
storage is far too small for audio and is written synchronously), decodes it
once into an `AudioBuffer`, switches the effect to Custom and plays it right
away as a preview at the current volume. Every later reminder plays that file
through the same volume gain, with 10 ms fades at both ends so a hard-cut file
cannot pop.

The audio never leaves the machine: nothing is uploaded, nothing is added to
the npm package, and the host half is not involved. It lives per browser
origin, so it survives restarts but not "clear site data" or a different
browser — pick the file again there, and the row says the file is gone.
**Clear** deletes the stored bytes and puts the effect back on the first
synthesized chime. If the file cannot be stored or decoded (private mode,
quota, unsupported codec), the row says so plainly and reminders fall back to a
synthesized chime.

### Browser console helpers

In the browser DevTools console:

```js
// Window focus state, the eight settings, the resolved notification language,
// toast timing, notification permission, the approval-button bridge state,
// the custom chime state, per-session running records, channel counters,
// duplicate suppressions, recent stops and the last stop of each kind, the
// unsettled waiting toasts and the raise-window trace (stats.lastActivation)
__dshTaskReminder.state()

// Send a task-complete toast right away and play the chime (does not wait for a task)
__dshTaskReminder.test()
__dshTaskReminder.test('question')   // the "Question" toast
__dshTaskReminder.test('approval')   // a real buttoned approval toast: press either
                                     // button and it reports back (settles nothing)
__dshTaskReminder.test('error')      // the error toast

// Play the selected effect at the current volume only
__dshTaskReminder.sound()

// Run the "land at your last question" step again on the session you are
// looking at (no toast needed) — handy to check it after a DSH update
__dshTaskReminder.focusQuestion()

// One line: where that landing last got to, plus the DSH DOM facts it relies
// on (session column / your message rows / scroll host counts and geometry)
__dshTaskReminder.report()

// What the Check for updates row is in right now (phase, versions, failure
// reason) — press the button, then read this to see how far the check got
__dshTaskReminder.state().update
```

### DSH Desktop: clicking a toast raises the app window

Installed with `dsh plugin --profile desktop add @hawkongz/dsh-task-reminder`
(see [Installation](#install-with-dsh-plugin)); every reminder works the same
as in the browser.

In the Electron desktop app the toast behaves the same, plus one step only the
host half can perform. A renderer process cannot pull back a window that
Windows minimized or that DSH hid into the tray: `window.focus()` does nothing
for it, and only the main process's `focusPrimaryWindow()`
(`restore()` → `show()` → `focus()`) can — reachable from a tray click and from
a second launch of the app (`dsh://open`, handled as `second-instance`). A
plugin page has neither that IPC nor the ability to navigate to an external
protocol.

So on a toast click the page sends `POST api/task-reminder/window-activation`
(a Connection exact-Fetch route registered by the host half, sharing the normal
`/api` channel and cookie auth), and the host half relaunches the app once: the
new process cannot take the single-instance lock, exits immediately, and the
running instance raises its window. The page sends that request on every click
whenever the page is in DSH Desktop (`'dshDesktop' in window`) — it never
short-circuits on `document.hasFocus()`, because in Electron that still reports
true when the window is merely covered or hidden, which would silently swallow
the click. The host half retries the launch (0 / 700 / 2200 ms: relaunch the exe, a
PowerShell helper that forces the foreground past Windows' foreground lock, then
explorer via the protocol) — but **it stops the moment the window is confirmed to be
in the foreground**: the helper exits 0 only when its target window is already (or
now) the foreground window, and on that signal every pending retry is dropped. The
helper also checks first and does not force anything when the window is already in
front (a minimized window does not count). A successful click therefore costs at
most ~0.7 s of attempts instead of stealing the foreground five times over 4 s — the
earlier unconditional ladder would pull you back out of whatever app you had
switched to. In a plain browser, on a DSH build where
the route is absent, or when the request fails, it is a silent no-op: opening
the right session is never affected. macOS uses `open dsh://open`; other
platforms skip it.

Two related behaviours: waiting-class toasts (question / plan review /
buttonless approval) are closed as soon as their wait clears (answered /
interaction closed / session gone), so the notification center never keeps a
stale entry that does nothing when clicked; and every hop of the raise-window
path leaves a trace, so reproducing "clicked but the window did not come up"
shows exactly where it broke:

```js
// { at, route, reason, status?, error? }
// reason: no-desktop / no-fetch / sent / answered / failed / error
__dshTaskReminder.state().stats.lastActivation
```

Sessions with an unsettled waiting toast are listed in
`__dshTaskReminder.state().waitingToasts` (it should drain quickly; a resident
entry means a toast was never closed).

### Self-check

```bash
npm test                 # contract + both halves
node test/verify-contract.mjs
node test/verify-client.mjs
node test/verify-host.mjs
```

`test/verify-contract.mjs` loads both halves into one process and asserts they
agree on the package name, the three routes (host-side absolute paths vs the
desktop-relative form the page must use) and the version, then feeds the host's
real `checkUpdate` / `applyUpdate` replies into the page-side update reducer —
a rename on one side can no longer drift green.

Runs the browser half under stubbed services (no browser needed) and asserts
the module identity, the wiring, the edge detection, the three deduplication
channels with repeated-edge suppression, the two toast timing modes, the
the three stop reasons (completion, the three wait kinds — approval request,
question, plan review — and error) with the turn/end
classification (including the unclosed-turn retry that keeps a cancel from
being misreported), the turn-number deduplication (a repeated edge for one
turn reports once even after the 5 s window expired or a stale replay cleared
the ticket, a new turn completing within 5 s still reports, and a same-turn
error and completion never each report), late-error retraction for one stop,
and an adversarial edge storm that must produce exactly one toast per turn,
the chime
sounding on every stop regardless of window state, the subagent filter (silent
for all three stop reasons while the switch is off, all three back when it is
on, forked sessions unaffected), the eight settings'
defaults / read / write / restore, the notification language (auto follows the
interface locale, pinned Chinese / English override it, the settings copy stays
on the interface language), the two toast-timing explanations (both rendered
under the row's title, one per line, with the exact copy pinned),
the seven work modes of the completion-unread
level flag (recover a completion whose edge this load never saw, latch once per
unread instance, release when the flag clears, never fire while a wait is
pending), the approval quick-decision chain end to end (bundle URL from the boot
graph, the dual-context file running as both page and worker, the notification
click relay with its one-window navigate rule, one `answer('allowed-once' |
'rejected')` per click, stale-toast and duplicate-click no-ops, and the plain
fallback when the request carries no `answer`), the oscillator parameters for
every effect
and volume, the custom chime path (IndexedDB store, `decodeAudioData` playback
at the chime volume, fallback when decoding or storing fails, and restore from
IndexedDB on the next load), all notification permission paths plus the in-page
permission-request button, the desktop window-activation request (only from DSH
Desktop and only while the window is not in the foreground), the landing after a toast click (the last row of your own messages is found in
the transcript column, hidden rows are skipped, the scroll container is taken
from `[data-conversation-scroll]` or the column's parent, the row is aligned
24 px below the top, alignment is re-checked until it holds, a top/bottom clamp
writes nothing, and a missing column / question / scroller gives up at the
poll limit with the outcome recorded), the suspended-AudioContext revival on a
user gesture, the **Check for updates** row (the version comparison including
prereleases, every state the row can be in — up to date / newer release / local
development install / no plugin manager / failure — the row sitting last on the
page, and the two host round trips with their POST bodies), and disposal.

`test/verify-host.mjs` runs the host half's own logic against stub `fetch`,
stub `profileContext` and stub `pluginManager` services: the registry check
(asking both registries, taking the highest answer, surviving one of them being
down, failing honestly when both are), the refusal paths (a `link:` install, a
composition without `pluginManager`), what `installBundle` is called with, the
failure diagnostics, and that all three Connection routes (window activation,
update check, update apply) register as `POST` with their exact paths.

## 🔧 Troubleshooting

* **The settings page is missing.** The plugin declares
  `@deepseek-ai/dsh-client-ui-settings` in `dsh.client.inject`; make sure the
  installation completed, then restart `dsh web` and hard-refresh. If the page
  still does not appear, re-run
  `dsh plugin --profile web add @hawkongz/dsh-task-reminder`.
* **A freshly published version will not install.** pnpm 11 defaults
  `minimumReleaseAge` to 1440 minutes (one day), so a release younger than that
  is not resolvable: `dsh plugin … add @hawkongz/dsh-task-reminder` prints
  `… 1.5.2 (1.5.4 is available)` and installs the previous version. Pin the
  release (`… add @hawkongz/dsh-task-reminder@1.5.4`), set
  `minimumReleaseAge: 0` in the profile's `pnpm-workspace.yaml`, or wait a day.
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
     once and choose Allow. Permission `denied`? The page deliberately offers
     no button for a blocked site: allow notifications for the site in the
     browser's address-bar site settings and the hint clears as soon as
     permission is granted — set the site's notification permission back to
     **Ask** instead and the button reappears. Permission is per origin —
     granting it for this app once covers every plugin on it.
  3. Browser accepted but nothing shows on screen? Windows is suppressing
     browser toasts. Check: Settings → System → Notifications (master switch
     **and** the per-app switch for your browser), Focus assist set to
     **Off** ("Priority only" hides ordinary toasts), and open the
     notification center with `Win + N` — the toast may have landed there
     unnoticed.
  4. Ten-second isolation test — run `new Notification('DSH test', { body: 'can
     you see me' })` in the page console. If that toast is invisible too, the
     suppression is on the Windows/browser side and no plugin code can fix it.
* **Watching video or playing a game fullscreen? No banner, and leaving
  fullscreen does not bring it back.** That is Windows, and there is a switch:
  Windows hides toast banners while a fullscreen app is in the foreground —
  **priority notifications included** — so the reminder only lands in the
  notification center (`Win + N`), and a suppressed banner is never replayed
  when you exit fullscreen. The switch is Settings → System → Notifications →
  **Do not disturb** → *"When using an app in fullscreen mode (priority
  banners are hidden too)"*: turn it off and banners appear over the
  fullscreen window. Verified on Windows 11 (build 26200): with the switch on,
  the fullscreen rule is bound to the *Alarms only* profile, which silences
  even the apps you put on the priority list; with it off the binding is gone
  and the toast shows. The plugin cannot work around this — a Web
  Notification has no way to bypass Do not disturb — but the chime keeps
  sounding, and the toast is waiting in the notification center.
* **The chime is silent.** The volume may be `0`, the browser tab may be muted,
  or the autoplay policy keeps the AudioContext suspended until your first
  interaction — click or type anywhere in the page once, then it plays.
* **The first chime of a browser session is delayed by a few seconds.** The
  first audio rendering inside Chrome starts the OS audio device (3-5 s on
  some Windows machines), and the autoplay policy allows that start only from
  a user gesture — no in-page code can start audio before one, so every
  website shares this cost. The habit that removes it: after opening the page,
  click anywhere in it once — that first gesture is what resumes the audio
  context (the plugin already queued a silent primer at load, so the device has
  had the whole page load to start); by the time you switch an effect or a task
  finishes, the device is warm and the chime is immediate.
* **A toast fires while you watch the conversation.** That is the **Always**
  timing mode doing its job. Switch the Toast timing row to **Only when
  unfocused** and the toast fires only when the tab is switched away or the
  browser window loses focus.
* **DSH Desktop: the toast opens the session but the window stays minimized.**
  Raising the window is host-half work added in 1.4.4, and the host reads
  plugins only at process start — a running app still holds the old `index.js`.
  Check the profile shows 1.5.4 or newer (1.4.4 is the minimum that has the route)
  (`dsh --profile desktop --dump-config | Select-String task-reminder`), then
  quit the app completely and open it again. A missing route is silent by
  design: the session still opens, only the window is not raised.

## 📌 Topics

[`dsh`](https://github.com/topics/dsh) [`deepseek-harness`](https://github.com/topics/deepseek-harness) [`cordis`](https://github.com/topics/cordis) [`cordis-plugin`](https://github.com/topics/cordis-plugin) [`web-ui`](https://github.com/topics/web-ui) [`notification`](https://github.com/topics/notification) [`reminder`](https://github.com/topics/reminder) [`web-audio`](https://github.com/topics/web-audio)

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## 📄 License

Licensed under the [MIT](LICENSE) License.
