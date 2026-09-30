---
version: "1.1.1"
name: dsh-android-develop-helper
aliases: ["Android 模拟器助手", "安卓开发助手", "android emulator helper"]
description: "Drive an Android emulator over ADB to develop, debug, test and localize errors in an app — screenshots, UI trees, taps/text/keys, APK install with hash verification, and logcat with a crash verdict. Multi-emulator (MuMu / LDPlayer / Nox / AVD) with configurable ADB ports."
---

# dsh-android-develop-helper

Operate an Android emulator through ADB so an app can be built, inspected, driven and debugged without a human at the screen.

Two entry points are equivalent — use whichever the environment offers:

- **Native tools** `android_devices`, `android_doctor`, `android_screenshot`, `android_ui`, `android_tap`, `android_input`, `android_wait`, `android_app`, `android_logcat` — present once the dsh bundle is installed, or when a composition row mounts `src/plugin.js`.
- **CLI** `node <repo>/bin/android-helper.mjs <command>` — always available, even with no bundle installed; every command takes `--json`.

`{baseDir}` is the directory holding this skill, which is the package root (referred to below as `<repo>`).
There are **no dependencies and no build step**; Node 20+ is enough.

Install it as a bundle — the shipped `cordis.patch.yml` inserts the tool row, so this is the whole setup:

```powershell
dsh plugin install dsh-android-develop-helper
```

The tools appear on the next dsh start. A source checkout works too, by pointing a composition row at `file://<abs path>/src/plugin.js`.

## Start here

```powershell
node <repo>/bin/android-helper.mjs doctor      # adb, device, screen, screenshot, UI tree, Activity
node <repo>/bin/android-helper.mjs devices     # every reachable emulator + which one is pinned
```

`doctor` prints a `✓/✗` line per capability. Run it first whenever a later command misbehaves.

## The one rule that prevents most failures

**A single emulator commonly answers on several ADB serials at once.** MuMu 12 exposes
`127.0.0.1:16384`, `127.0.0.1:7555` and `emulator-5554` for the *same* instance, while every
MuMu device reports the same `ro.product.model`. Choosing by serial string therefore produces
either `more than one device/emulator` or silently working against the wrong instance.

The tool groups serials by a fingerprint read over the wire (`android_id` + build fingerprint +
model), collapses each group to one canonical serial, and pins every later command with `-s`.
You do not need to manage this — but when several *distinct* instances are running, pass
`--device <serial>` explicitly. That is the only case that requires a decision.

## Configuration (multi-emulator)

`<repo>/config.json`, CLI flags, or `ANDROID_HELPER_*` environment variables. Everything has a
working default, and `emulatorType` left unset is auto-detected from whichever vendor's launcher is
installed.

| Key | Meaning | Example |
|---|---|---|
| `adbPath` | adb executable; auto-detected from `ANDROID_HOME`, vendor installs, then `PATH` | `D:\...\adb_41\adb.exe` |
| `emulatorType` | `mumu` / `ldplayer` / `nox` / `avd` / `genymotion` / `custom` | `mumu` |
| `adbPort` | connect to `127.0.0.1:<adbPort>` | `16384` |
| `consolePort` | console port; the ADB port is inferred as `consolePort + 1` | `5554` |
| `deviceSerial` | explicit serial; highest priority, skips all inference | `emulator-5554` |
| `autoDiscover` | run `adb devices` and probe ports (default `true`) | `true` |
| `ports` | extra candidate ports to probe | `[16384, 7555]` |

Resolution order: `deviceSerial` → `adbPort` → auto-discovery → refuse when several distinct
devices are present.

**Ask the vendor before probing.** When the vendor ships a management CLI the ADB port is read
directly instead of guessed — `MuMuManager info -v all` for MuMu, `ldconsole list2` for LDPlayer:

```
$ node <repo>/bin/android-helper.mjs instances
模拟器类型: mumu
[0] MuMu安卓设备  adb=127.0.0.1:16384  android=15.0  运行中
```

This is why the MuMu 12 port never has to be read out of the emulator's 问题诊断 dialog, and why
only the ports the vendor does not know about fall back to probing a range.

Change a value once and it sticks:

```powershell
node <repo>/bin/android-helper.mjs config --set adbPort=16384
node <repo>/bin/android-helper.mjs config --set emulatorType=mumu
```

`consolePort` and `adbPort` differ by exactly one for AVD-style emulators. When an emulator is
started as `-ports 5554,9999`, the serial `emulator-5554` says nothing about the real ADB port,
which is why `adbPort` is a first-class setting rather than something inferred from the serial.

## Starting the emulator

`adb connect` only reaches an instance that is already running:

```powershell
node <repo>/bin/android-helper.mjs start-emulator [--wait] [--timeout MS] [--launcher PATH]
```

It resolves the vendor launcher (MuMu → `MuMuManager control --vmindex 0 launch`, LDPlayer →
`dnplayer.exe`, AVD → `emulator.exe`), and **returns immediately when something is already
listening** rather than starting a second instance.

## Seeing the screen

```powershell
node <repo>/bin/android-helper.mjs shot --scale 0.4          # → artifacts/<run>/0-shot.png
node <repo>/bin/android-helper.mjs ui --max 60               # indexed element list
node <repo>/bin/android-helper.mjs ui --labels-only --refresh
```

`shot` reads the **raw framebuffer**, crops and downscales it, then PNG-encodes it — a 720x1280
screen is 3.5 MB raw and lands in the tens of KB. That is why `--scale` exists: read the layout at
0.4–0.5, and only go to `1.0` when fine detail genuinely matters. `--region x,y,w,h` crops first.

`ui` prints one line per actionable element, with a small integer index you can feed straight back:

```
#5 Image id=scheduleAdd @504,93 [tap]
#6 Image id=scheduleImport @564,93 [tap]
```

Raw `uiautomator` XML is ~34 KB and takes ~2 s to produce; this digest is usually under 3 KB.
Dumps are cached briefly — pass `--refresh` after anything that changes pixels.

## Acting on the screen

```powershell
node <repo>/bin/android-helper.mjs tap-text "从教务导入"     # auto-waits, resolves nearest clickable ancestor
node <repo>/bin/android-helper.mjs tap-id scheduleImport
node <repo>/bin/android-helper.mjs tap-node 6               # by ui index
node <repo>/bin/android-helper.mjs tap-xy 360 900           # last resort
node <repo>/bin/android-helper.mjs tap-and-wait 课表 --exact # tap + settle + new UI tree + screenshot, one call
node <repo>/bin/android-helper.mjs scroll down --times 3
node <repo>/bin/android-helper.mjs text "408" --replace
node <repo>/bin/android-helper.mjs key back
```

Prefer a semantic target over coordinates. `uiautomator` costs ~2 s per dump, so `tap-and-wait`
exists to collapse *tap → sleep → dump → screenshot* into a single round trip.

Non-ASCII text needs the **ADBKeyboard** IME (`com.android.adbkeyboard`); without it only the ASCII
part is typed and the command returns a warning rather than silently writing a different string.

## Waiting without sleeping

```powershell
node <repo>/bin/android-helper.mjs wait-text "个人课表查询" --timeout 30000
node <repo>/bin/android-helper.mjs wait-id bottom_sheet_create_schedule_btn
node <repo>/bin/android-helper.mjs wait-activity "ScheduleActivity"
node <repo>/bin/android-helper.mjs wait-idle
```

On timeout these raise an error that includes the current Activity, the visible element list and a
screenshot, so a failed wait is diagnosable instead of just slow.

## Apps

```powershell
node <repo>/bin/android-helper.mjs apk-info build/app.apk       # package/version/SDK, no aapt needed
node <repo>/bin/android-helper.mjs install build/app.apk        # installs AND verifies
node <repo>/bin/android-helper.mjs start com.example.app        # resolves the launcher Activity itself
node <repo>/bin/android-helper.mjs stop com.example.app
node <repo>/bin/android-helper.mjs grant com.example.app        # re-grant runtime permissions
node <repo>/bin/android-helper.mjs pkg com.example.app
```

`install` does not trust `Success`, for two distinct reasons.

First, it resolves `pm path`, hashes the on-device APK and compares it with the local file — only the
64-character digest crosses the wire, so a 40 MB APK is verified in well under a second. A mismatch
exits non-zero and names both hashes.

Second, **`Success` can appear inside a failed install**. Android 13+ streamed installs emit:

```
Performing Streamed Install
Success: streamed 37341 bytes
Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: … signatures do not match …]
```

with exit code **0**. The `Success:` line describes the byte stream, not the package commit. Any
`/Success/ && exit === 0` check reports success for a package that was never replaced — do not
write one. The tool treats `Failure [CODE]` as authoritative and translates common codes into a
next step, e.g. `INSTALL_FAILED_UPDATE_INCOMPATIBLE` → "the installed package was signed with a
different key; uninstall first or keep one signing key".

`grant` reads every `granted=false` runtime permission out of `dumpsys package` and grants it. This
matters because **`pm clear` revokes what `install -g` granted**, so an app you just cleared starts
normally and then silently fails to notify.

## Escape hatches

```powershell
node <repo>/bin/android-helper.mjs shell "run-as com.example.app cat shared_prefs/prefs.xml"
node <repo>/bin/android-helper.mjs shell "dumpsys alarm | grep -A2 com.example.app"
node <repo>/bin/android-helper.mjs rotate portrait
```

`shell` runs an arbitrary device command against the pinned serial. Use it to read an app's own
private state, check `dumpsys` subsystems (alarm, notification, activity), or change settings.

`rotate` pins the screen orientation. This matters because `wm size` always reports the panel's
*natural* orientation — on a landscape screen it is wrong in both dimensions, and the toolkit
swaps width/height so `scroll` clamps to the right box.

## Building an APK without Gradle

When the task involves building the app too, the repository carries a toolchain that needs neither
Gradle nor Android Studio:

```powershell
node <repo>/tools/install-sdk.mjs                                   # ~126 MB, one time
node <repo>/tools/build-apk.mjs --project examples/dorm-duty        # ~4 s
```

`install-sdk.mjs` reads Google's `repository2-3.xml` manifest and unpacks only `platforms;android-N`,
`build-tools` and `platform-tools` — `sdkmanager` drags in Gradle-era machinery, needs licence
acceptance and is JDK-sensitive. The build path is
`aapt2 compile → aapt2 link → javac → d8 → package → apksigner`, with packaging implemented in
`src/zip.js` because `resources.arsc` must be **stored and 4-byte aligned** for the platform's mmap
path. `zipalign -c 4` re-checks the result.

`examples/dorm-duty/` is a worked example (Java + classic Views + explicit `android:id` on every
control). Its README explains why classic Views beat Compose *for an app that will be driven over
ADB*: Compose merges the tree into few semantic nodes, so without `testTag` the plugin can only see
one `AndroidComposeView` and element targeting degrades to coordinate taps.

## Finding out why it broke

```powershell
node <repo>/bin/android-helper.mjs logcat --package com.example.app --grep "Exception|FATAL" --max 200
node <repo>/bin/android-helper.mjs diagnose com.example.app     # parsed stack + source location + screenshot
node <repo>/bin/android-helper.mjs activity                     # what is actually in front
```

`diagnose` is not `grep FATAL`. It parses three kinds of evidence on their own terms:

| Evidence | Parsed as |
|---|---|
| `crashes` | `FATAL EXCEPTION` blocks → exception, message, thread, process, call stack, `Caused by` chain |
| `tombstones` | native crash blocks → signal, fault address, backtrace (delimited by log tag, not by matching single lines) |
| `findings` | shapes with no stack to parse: ANR, StrictMode, OOM, process death |

The field that matters is `location`: **the first frame that belongs to the app**, skipping framework
frames like `android.view.View.performClick` and desugared synthetics like `-$$Nest$msplitBill`.
That is the line to open:

```
崩溃: java.lang.ArithmeticException: divide by zero
  线程: main
  进程: com.example.dormduty (pid 44272)
  定位: MainActivity.java:197  ← com.example.dormduty.MainActivity.splitBill
  调用栈:
    at com.example.dormduty.MainActivity.splitBill(MainActivity.java:197)
    at com.example.dormduty.MainActivity$7.onClick(MainActivity.java:126)
    at android.view.View.performClick(View.java:8081)
```

Three things decide whether the verdict is trustworthy:

- **Did the process actually die?** `diagnose` samples the pid before and after. A crash kills the
  process, so `pid → (gone)` is evidence independent of the log, and it separates "the app crashed"
  from "the app logged an error".
- **Whose crash is it?** The `crash` buffer is device-global, and `uiautomator` SIGSEGVs on every
  dump on some emulator images. Records attributable to another process go to `ignored`, not into
  `findings` — being set aside explicitly is not the same as being silently dropped.
- **Do not let a synthetic frame truncate the trace.** R8 emits method names containing `-`
  (`MainActivity.-$$Nest$msplitBill`); a frame pattern that rejects `-` cuts the stack at the first
  synthetic frame and hides every real caller below it.

Logs say *where* it broke; the screenshot says *what the user saw*. Read them together — and capture
the screenshot before restarting the app, because the failing frame is gone afterwards.

### Flutter / Dart apps

**Driving a Flutter UI needs no special handling.** Flutter mirrors its semantics tree into the
Android accessibility hierarchy, and `Semantics(identifier: 'tvStatus1', …)` becomes
`AccessibilityNodeInfo.viewIdResourceName` — the `resource-id` that `ui` prints and `tap-id`
matches. Observed on a real screen:

```
#2 View desc="0 / 0" id=tvProgress @114,183
#9 Button desc="生成值日表" id=btnGenerate @592,1214
```

Three measured differences from a classic View app:

- **The label sits in `content-desc`, not `android:text`.** The `text` selector therefore matches
  both — otherwise `tap-text` would refuse to find an element `ui` had just printed. `desc` still
  targets `content-desc` specifically.
- **Only on-screen semantics nodes are published at all.** A control scrolled out of view is not in
  the tree — not marked invisible, simply absent, and `--no-compressed` does not bring it back. On a
  Flutter screen, scroll first and search second; there is no other order.
- **A Dart error does not kill the process**, so `pid → (gone)` is *not* the evidence it is for
  Java. `diagnose` parses the Dart stack separately — frames are `package:` URIs, not file names —
  and reports the first frame from the app's own package:

  ```
  崩溃: IntegerDivisionByZeroException
    定位: duty.dart:48  ← splitBill
    调用栈:
      at splitBill(package:dorm_duty_flutter/duty.dart:48)
  ```

  `location.file` is the basename, matching the Java shape, so the same "read line N and check it"
  habit works.

**Line numbers only exist in a debug (JIT) build.** A profile build prints the exception and the
frames, but the AOT compiler inlines the failing call away, so the frame reads
`_splitBill (package:…/duty_page.dart)` with no line; a release build prints no Dart stack at all.
If a Flutter crash localises to a file but not to a line, that is the reason — rebuild with
`flutter build apk --debug`.

## Practical loop

1. `doctor` — confirm the pipeline, and note which emulator/port is in use.
2. `install <apk>` — the hash check catches a stale build being tested by mistake.
3. `start <pkg>` then `wait-activity <Activity>` — never `sleep` and hope.
4. `ui` → `tap-node`/`tap-text` → `tap-and-wait` — drive by element, not by coordinate.
5. On a failure: `diagnose <pkg>` plus `shot`, then read the two together.
6. After the fix: rebuild, `install`, re-run the same steps and confirm the crash is gone.

## Notes and limits

- `uiautomator dump` costs ~2 s and occasionally segfaults *after* writing on some emulator images.
  The reader tolerates that and judges completeness from the payload, so the exit code is ignored.
- **`ui` reports only what is currently on screen.** A compressed dump drops nodes scrolled out of
  view, so "the row is not there" and "the row is below the fold" look identical. Pass
  `--no-compressed` (CLI) / `compressed: false` (tool) to dump the whole view tree, or scroll first.
  This is not hypothetical: it made an end-to-end test read a missing row as null on a landscape
  emulator. Pin the orientation with `rotate` when geometry matters.
- **A `WebView`'s DOM is readable.** Its accessibility tree is published like any other, and an HTML
  `id` arrives as the `resource-id` — so `tap-id` and `tap-text` work inside a page too. Two
  caveats: the tree is built **lazily**, so the very first `ui` after an app starts may show one
  empty `WebView` node and the *second* call shows the content (retry before concluding anything);
  and only elements with an accessibility role appear, so `canvas`, shadow DOM, cross-origin
  `iframe` contents and layout-only `div`s are not reachable. Reading those, running JS or watching
  network traffic needs CDP (`adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`),
  which this toolkit does not provide. `examples/webview-probe/` is the 12 KB app that measures all
  of this.
- The emulator's own `adb` (e.g. `MuMu\nx_main\adb.exe`) is preferred when found, because a
  mismatched adb version is a common source of `device offline`.
- Full command and output logs are written to `<repo>/artifacts/<timestamp>-<label>/log.txt` with no
  truncation — read that file when a command's result looks wrong. Each tool call gets its own
  directory.
- `find` excludes disabled and zero-area nodes by default, which is right for resolving a tap target
  and wrong for inspecting state. To assert "this button is disabled", pass `enabledOnly: false`.
- Tests: `npm test` (131 unit), `npm run test:live` (9 against a real emulator),
  `npm run test:e2e` (2 that drive the example app end to end),
  `npm run test:crash` (3 that raise a real exception and verify the reported `file:line` against the
  source on disk). `npm run test:all` runs everything serially — the live suites share one device and
  interfere if run in parallel.
