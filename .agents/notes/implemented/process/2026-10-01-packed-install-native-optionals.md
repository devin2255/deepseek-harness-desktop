# Agent Note: Packed-install verification of native optional packages

Status: implemented

English | [中文](2026-10-01-packed-install-native-optionals.zh.md)

## Problem

The packed dsh consumer omitted every optional npm dependency to prove startup without a Landlock platform package. Koffi also distributes its Linux native binary as an optional package. Omitting it makes npm compile Koffi from source, which can fail even when the ordinary consumer installation succeeds. That failure prevents the release check from reaching the installed executable and does not describe the default user path.

## Decision

The packed-consumer check performs npm's default installation with package scripts and optional dependencies enabled. It launches the installed `dsh --version`, then launches it again while the Linux Landlock platform package is unavailable to the Landlock entry. The second probe temporarily moves every resolved copy of the platform package inside the disposable consumer and restores them in `finally`; when npm did not install that optional package, the probe runs against its existing absence. The packed dsh, vendored, and Landlock entry tarballs still come from the job's local outputs. Landlock platform binaries are not built on this runner and may resolve from the registry or remain absent.

## Alternatives considered

**Upgrade Koffi so a forced source build passes.** A successful source build would not make an all-optionals-omitted install representative of a normal consumer install, and a native upgrade affects every Windows caller.

**Ignore npm package scripts while omitting optional dependencies.** That would let the installer finish without testing native package installation failures.

**Build and include every Landlock platform tarball in the dsh job.** The platform binaries require musl toolchains and architecture-specific builds owned by the independent native release sequence.

## Consequences

The default probe covers native prebuild installation and internal tarball resolution; the isolated absence probe retains the Landlock startup guarantee without removing unrelated optional binaries. An optional Landlock platform package can be fetched from the registry, so the probe does not claim a fully registry-independent install. `dsh --version` proves startup, not execution of every sandbox backend.
