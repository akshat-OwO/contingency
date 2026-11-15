---
status: accepted
---

# A Teaching Recording owns its Target App Build

> Decided in [#726](https://github.com/akshat-OwO/contingency/issues/726).

A Target App Build used to belong to the native Teaching session that claimed it. The upload was deleted when that session closed, and no other session could claim it, so the recording's Dry Run could not install the build it was taught against. It needed a second upload, or it relied on whatever was still installed on the device. A Teaching Recording is process-independent and may have several Dry Runs. Its build now shares the recording's lifetime.

## Rules

- **Ownership moves when the recording begins.** A native Teaching session begins its recording at startup. At that point its claimed build moves into the recording's directory, which the catalog's `.gitignore` already excludes, and the session's run installs it from there. Until then the session owns the upload, and a startup that fails or is cancelled first deletes it.
- **A process holds the build while its Teaching session is open.** The manifest names the holding process. A session that closes with nothing recorded deletes the build. A session that closes with a kept recording releases its hold and leaves the build in the recording.
- **Every Dry Run installs the recording's build implicitly.** A Dry Run start that names a build is refused. The Dry Run tests the Flow against what was taught, like the prerequisites fixed in [ADR 0047](./0047-dry-run-prerequisites-are-fixed-at-startup.md). A new build needs a new Teaching.
- **The build is deleted at Cleanup, or when no session can record with it again.** A discard returns the recording to setup. While a live process still holds the build, the discard keeps it so the user can record again in the same session. A discard with no live holder deletes it.

## Considered Options

- **Keep session ownership and rely on the installed app.** Rejected: this is the failure the issue reports.
- **Delete the build when the first Dry Run ends.** Rejected: a failed Dry Run can be retried, and a passed one keeps Teaching evidence until the user verifies the Flow.
- **Keep the build in the process temp root.** Rejected: the recording outlives its process, so a Dry Run after a restart would fail the same way.

## Consequences

- A recording directory can hold a build of up to 4 GB until Cleanup.
- An app that was installed without an upload behaves as before.
