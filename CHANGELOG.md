# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.1] — 2026-09-30

Two defects found by the workflow's first real run — both invisible on the
Windows machine this toolkit was developed on.

### Fixed

- **Bad arguments reached the device.** `android_input`, `android_wait` and
  `android_app` checked their `action` *inside* `withDevice`, i.e. after the
  emulator had been resolved. On a machine with no emulator running, a caller's
  typo came back as "没有可用设备": slower, and it hides the actual mistake. The
  unit test asserting this behaviour is named "rejects unknown actions before
  touching a device" — it passed locally only because an emulator happened to be
  running. The checks now run first, and the action sets are shared with the
  schemas so the enum a model reads cannot drift from the switch that runs.
- **Vendor launcher candidates were Windows paths on every platform.** The
  MuMu / LDPlayer / Nox locations are built from `%ProgramFiles%` and literal
  `D:\...`, so off Windows the candidate list held strings that are not absolute
  paths and can never exist. Candidates are now filtered with
  `path.isAbsolute`, and the platform-bound test expectations are marked as
  platform-bound rather than silently wrong.

### Changed

- CI runs on `ubuntu-latest` **and** `windows-latest`. Windows is the platform
  this toolkit targets — only testing on Linux meant the platform the code is
  actually for was never exercised.

## [1.1.0] — 2026-09-30

First release published as an installable dsh bundle.

### Added

- `cordis.patch.yml` and the `dsh.bundle.patch` manifest entry, so the package can
  be installed as a profile bundle instead of being mounted by an absolute
  `file:///…/src/plugin.js` row. The patch inserts the row under the id
  `android-develop-helper` and passes `timeoutMs` plus an empty `flags` object,
  which keeps the emulator auto-detection in charge of vendor selection.
- `SKILL.md` — the filesystem skill that lets an agent discover the toolkit, kept
  in the repository so the skill and the code ship together.
- `LICENSE` (MIT), `CHANGELOG.md`, `.gitattributes` and a GitHub Actions workflow
  running the unit suite on Node 20 and 22.
- `repository` / `homepage` / `bugs` metadata and a `./cordis.patch.yml` export.

### Changed

- Package name is now `dsh-android-develop-helper` (all lowercase) to match npm
  naming rules and the Cordis loader identity the plugin already exports.
- `artifacts/` now resolves against the caller's working directory when no
  explicit `artifactsDir` is configured. Installed as a bundle the package lives
  in the profile's `node_modules`, and writing run logs into `node_modules` both
  pollutes an installed dependency and gets wiped by the next `pnpm install`.
- The example debug keystore is committed rather than ignored. Every build signs
  with the same certificate, which is what makes `install -r` upgrades work
  instead of failing with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`.
- `npm test` no longer quotes the test glob. Quoted, the pattern only works on
  Node 21+ (which expands globs itself); unquoted, a POSIX shell expands it and
  the suite also runs on the declared Node 20 floor.

## [1.0.0] — 2026-09-19

Initial version, formerly developed as `dsh-mumu`.

### Added

- Nine host tools — `android_devices`, `android_doctor`, `android_screenshot`,
  `android_ui`, `android_tap`, `android_input`, `android_wait`, `android_app`,
  `android_logcat` — plus a matching CLI (`bin/android-helper.mjs`) with `--json`
  on every command.
- Multi-emulator device resolution: vendor CLIs first (`MuMuManager info -v all`,
  `ldconsole list2`), then TCP probing of vendor port ranges, then de-duplication
  of the several serials one emulator answers on, using a fingerprint read over
  the wire (`android_id` + build fingerprint + model).
- Screen capture with a self-implemented framebuffer decoder and PNG encoder, plus
  indexed UI-tree digests.
- APK inspection without `aapt` (real AXML parsing), install with on-device SHA256
  verification, and `Failure [CODE]`-authoritative install verdicts.
- Logcat analysis that separates `FATAL EXCEPTION` blocks, native tombstones and
  stackless findings, and reports the first app-owned frame as a source location.
- Gradle-free build path (`tools/install-sdk.mjs`, `tools/build-apk.mjs`) and the
  `examples/dorm-duty` verification app.
- 129 unit tests plus 9 live, 2 end-to-end and 3 crash-localization tests.
