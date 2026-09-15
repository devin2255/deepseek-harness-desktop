# DeepSeek Harness Desktop Windows Installer Design

English | [中文](2026-08-24-windows-installer-design.zh.md)

Status: product, technical design, and written specification approved on 2026-08-24.

Build instructions and current qualification limits are maintained in the [desktop README](../../../apps/desktop/README.md#windows-installer-development); this specification defines the acceptance target, not evidence that every target has passed.

## Decision summary

DeepSeek Harness Desktop ships as a single assisted Windows installer that a user can double-click on a clean Windows computer. The installed application is self-contained: it must not require a source checkout, Node.js, pnpm, a package-manager store, or paths from the build computer. The first release supports Windows 10 and Windows 11 on x64.

The installer uses `electron-builder` with an assisted NSIS target. It installs per user without administrator privileges, offers a writable default directory and a custom directory selector, and exposes the user-facing choices approved for desktop shortcuts, Start Menu shortcuts, login startup, and immediate launch.

## Product requirements

The release artifact is one file named `DeepSeek-Harness-Setup-<version>-x64.exe`. Opening it starts a visible installation flow rather than launching an unpacked application or extracting a portable directory.

The default installation directory is `%LOCALAPPDATA%\Programs\DeepSeek Harness`. The directory page lets the user select another writable directory. The installer rejects protected or unwritable destinations with a corrective message and does not silently request elevation.

The options page contains these independent choices:

- Create a desktop shortcut, enabled by default.
- Create a Start Menu application shortcut, enabled by default.
- Start DeepSeek Harness when the user signs in, disabled by default.

The completion page contains “Launch DeepSeek Harness now,” enabled by default. The installer registers an uninstaller in Windows Installed Apps regardless of whether the Start Menu application shortcut is selected.

## Installation flow

The assisted flow has five user-visible stages: welcome, destination directory, optional integrations, installation progress, and completion. Back and Cancel remain available before file installation begins. Cancellation or failure must not leave an application entry that points to an incomplete installation.

Installation writes a complete version into a staging location under the selected installation parent, validates the staged application, and only then makes that version active. A failed replacement leaves the last complete version usable or reports that no usable installation exists. The installer never combines files from two application versions.

The application uses a stable Windows App User Model ID so taskbar grouping, notifications, shortcuts, and future upgrades refer to the same product identity.

## Program and user data ownership

Program files live only under the selected installation directory. Mutable application state lives under `%APPDATA%\DeepSeek Harness`; logs, settings, credentials references, sessions, runtime profiles, and other generated state must not be written into the program directory.

The packaged desktop process supplies an explicit Harness home beneath `%APPDATA%\DeepSeek Harness`. It does not resolve plugins or profiles from the repository, the package-manager store, the build user's home directory, or the development `~/.dsh` directory. Importing development data from `~/.dsh` is outside the first installer release and must not happen implicitly.

Credential values remain governed by the existing credentials capability. The installer does not embed API keys, copy a root `.env`, or log secrets.

## Self-contained application closure

The installed application includes Electron, the renderer assets, the DeepSeek Harness runtime, the selected desktop profile and plugins, required JavaScript dependencies, and required Windows x64 native modules. It can install, start, and reach its first-run configuration experience while offline.

Executable CLI files, Cordis configuration, web assets, native modules, and any resources opened by filesystem path are packaged outside ASAR when their runtime loader requires ordinary files. Main-process and renderer code may remain in ASAR where Electron supports it.

The build fails when the packaged closure contains a symlink or junction to the source repository or package-manager store, an absolute build-computer path, a missing required peer dependency, a missing profile or web resource, an unavailable native binary, or a CLI entry that the production process launcher cannot execute. Validation runs against the final packaged directory, not only the source dependency graph.

## Application startup and readiness

Double-clicking an installed shortcut creates a native application window immediately. A lightweight startup surface is shown before Harness initialization and reports condition-based stages such as loading the local runtime, validating the profile, and starting the local service; it does not wait for an arbitrary animation delay.

The main renderer loads only after an authenticated local readiness probe confirms that the expected application version and required capabilities are available. The local service binds only to loopback, uses an ephemeral or application-owned port, and is not considered ready merely because a process exists or a TCP port accepts connections.

Startup has a bounded timeout. Failure replaces the progress surface with a safe error view that summarizes the failing stage and provides Retry, Open Logs, and Exit actions. Error text and logs redact credentials and do not expose internal stack traces as the primary user message.

Only one desktop application instance owns a given user-data directory. A second launch focuses the existing window and forwards the supported launch intent instead of starting a competing Harness service.

## Login startup and shortcuts

Login startup is registered for the current user through `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` and points to the installed executable using safely quoted arguments. Re-running the installer updates or removes that value to match the selected option. Uninstall removes it only when it belongs to this installation.

Desktop and Start Menu shortcuts use the installed executable, stable product identity, product icon, and selected installation directory. Upgrade repairs selected shortcuts when the installation path or executable layout changes and removes obsolete product-owned shortcuts.

## Upgrade behavior

Opening a newer installer detects an existing per-user installation. It defaults to the existing destination and preserves the previous shortcut and login-startup choices while still allowing the user to change them.

Before replacement, the installer asks the running application to exit and waits for its owned process tree to stop. If the application cannot close, the installer presents a retry-or-cancel decision and does not overwrite live binaries. User data remains in place. Any future user-data schema migration must be atomic or recoverable and belongs to the component that owns that schema.

Downgrade and same-version reinstall are explicit states, not accidental upgrades. The installer may allow repair of the same version, but it must warn before a downgrade when stored data may be newer than the target runtime.

## Uninstall behavior

Uninstall removes program files, product-owned shortcuts, the product-owned login-startup registration, and the Installed Apps entry. It preserves `%APPDATA%\DeepSeek Harness` by default so reinstalling does not discard settings, credentials references, sessions, or logs.

The uninstaller offers a separate “Delete user data” choice that is disabled by default and shows the exact data directory. Selecting it requires explicit confirmation. Deletion is limited to the resolved product data directory; junctions, symlinks, unexpected path resolution, or a path outside the expected `%APPDATA%` product root stop deletion and leave the data intact.

## Signing and Windows reputation

The first test release may be unsigned, so release notes and the download page must explain the expected Microsoft Defender SmartScreen warning. The build configuration provides signing hooks without requiring a certificate for local builds. Production publication remains blocked until the release owner makes an explicit signing decision.

Installer and application metadata use one publisher name, product name, icon set, executable name, version, and upgrade identity. The eventual signing pipeline signs the application executables before the outer installer and verifies signatures after packaging.

## Verification strategy

Unit tests cover installer-option mapping, path resolution, ownership checks, launch arguments, readiness transitions, timeout recovery, and redaction. Static package validation inspects the final artifact for dependency closure, executable resources, native modules, forbidden links, and build-machine paths.

Automated Windows x64 tests start from a clean user profile and verify assisted installation into the default directory and a custom directory, each shortcut option, login startup registration, immediate launch, first-run readiness, and operation without Node.js, pnpm, the repository, the package-manager store, or network access.

Upgrade tests install an older artifact, create representative user state, run the newer installer, and verify process shutdown, option preservation, complete version replacement, and user-data retention. Uninstall tests cover both preserved data and explicitly deleted data, including rejection of unsafe redirected paths. Regression coverage includes an existing development profile and a corrupt packaged profile so neither can cause a silent no-window failure.

Windows CI builds the installer and publishes it as a versioned artifact. Release validation records the artifact checksum, installed version, tested Windows image, and whether the artifact is signed.

## Scope

This release includes the Windows x64 assisted installer, destination selection, desktop and Start Menu shortcuts, optional login startup, completion-page launch, upgrade foundations, uninstall data choice, self-contained dependency closure, native startup and recovery UI, automated installer tests, bilingual documentation, an Agent Note for the implementation, and a CI installer artifact.

This release excludes Windows ARM64, macOS, Linux, in-application automatic updates, purchasing or operating a code-signing certificate, MSI or enterprise deployment policy, crash-reporting services, implicit migration from development `~/.dsh` data, and final brand artwork.

## Acceptance criteria

The installer design is satisfied when a non-developer can download one EXE onto a clean supported Windows x64 computer, choose the installation directory and integrations, finish installation without administrator privileges or internet access, and see a responsive DeepSeek Harness window that reaches first-run setup or a recoverable error screen. The same artifact must upgrade and uninstall predictably, preserve user data by default, delete it only through explicit safe confirmation, and contain no runtime dependency on the build environment.
