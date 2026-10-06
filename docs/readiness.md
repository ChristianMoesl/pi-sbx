# Image startup readiness contract

pi-sbx keeps Pi on the host and establishes a tool worker through `sbx exec`. A sandbox appearing in `sbx ls` is discovery, not proof that its initialization has finished. The worker's `ready` message is the final execution gate.

Images can opt into an additional initialization barrier using `SBX_STARTUP_DIR` and `sandbox-startup wait`. This is an **image capability**, independent of Radar, a particular launcher, or the layout of an image's private status files. pi-sbx never creates sandboxes or runs startup hooks.

## Contract at a glance

| Sandbox environment | Worker behavior |
| --- | --- |
| `SBX_STARTUP_DIR` unset or empty | Report ready once the worker can accept requests. Do not invoke a helper. |
| `SBX_STARTUP_DIR` nonempty | Run `sandbox-startup wait --timeout 60` inside the sandbox. Report ready only after exit code zero. |
| Configured startup directory, missing/unexecutable helper | Fail initialization. Do not bypass readiness. |
| Helper exits nonzero, is killed, or times out | Fail initialization. Do not enable tools or switch to host execution. |

The helper is resolved from the **sandbox's PATH**, runs as the worker's sandbox user, inherits the sandbox environment, and is invoked as an argv array without a shell. The host's environment is not forwarded. Whitespace-only or invalid directory values are not interpreted as an opt-out; validation belongs to the helper.

## Responsibilities

### Image and kit

The image supplies the `sandbox-startup` executable; the kit or image startup lifecycle invokes `sandbox-startup run` (or its equivalent) to execute initialization. The readiness observer must **not** be responsible for starting the work it observes.

The existing generic startup runner uses an absolute `SBX_STARTUP_DIR`, executes its regular executable files, and records progress privately. For another implementation of this contract, the `wait` command must:

1. Wait for required initialization to succeed for the **current runtime boot**, including when the observer starts before the hooks.
2. Return zero promptly when that initialization has already succeeded.
3. Reject a recorded initialization failure promptly with a nonzero exit code.
4. Treat missing, incomplete, malformed, or previous-boot success state as not ready—not as success.
5. Honor `--timeout 60` as an upper waiting bound and exit nonzero when it expires.
6. Observe state without executing or automatically retrying hooks.
7. Be safe for concurrent observers, including a launcher waiting at the same time as pi-sbx.

A durable success file must be tied to the current boot. For example, the generic runner combines the kernel boot ID and PID 1's start time and writes state atomically. Those details are **not** part of pi-sbx's API: pi-sbx never reads that file, knows its location, or interprets its JSON.

A failed hook may leave a sandbox accessible for inspection. Returning success from an outer kit hook to preserve access must not turn the observer's recorded failure into readiness success.

### pi-sbx

pi-sbx discovers a matching sandbox and eagerly connects its existing worker. The worker sends `initializing` before invoking the optional helper and sends `ready` only after successful completion. Until then, it rejects execution requests instead of buffering commands for later.

pi-sbx depends only on the environment opt-in, command invocation, and exit status. It does not read launcher configuration, rerun `run`, manage startup directories, install missing helpers, or reimplement boot-token validation.

## Example image/kit setup

Assuming the image already includes the generic `sandbox-startup` helper, supply the environment variable through your sandbox's environment configuration:

```dotenv
SBX_STARTUP_DIR=/absolute/host/startup.d
```

Mount that directory at the corresponding path, preferably read-only:

```sh
sbx create --name example --env-file /absolute/host/sandbox.env \
  ./my-sandbox-kit "$PWD" /absolute/host/startup.d:ro
```

The kit must invoke its hook runner under the same user/environment as the readiness observer. With the existing generic runner, a native SBX startup hook can use:

```yaml
setup:
  startup:
    - command: [sh, -c, "sandbox-startup run || true"]
      user: "1000"
      background: true
      description: Initialize the image and retain private readiness state
```

Here `|| true` keeps the sandbox accessible after a hook failure; the generic runner records that failure and `wait` still returns nonzero. Do not use this pattern with a helper that does not preserve failures.

No pi-sbx-specific flag or Radar setting is required. Start Pi with pi-sbx enabled before or after the sandbox is created. A launcher may independently run the same `wait` command before its own setup tasks.

## Waiting is not a fixed delay

These bounds serve different purposes:

| Bound | Purpose |
| --- | --- |
| Up to 60 seconds of discovery, with roughly one-second polling intervals | Find a matching sandbox that may not exist yet. Discovery errors terminate the attempt with a warning. |
| Up to 15 seconds to start the worker | Establish the SBX/Node transport. |
| Up to 60 seconds for image initialization after the worker starts | Observe the configured hooks. The transport allows 65 seconds after `initializing` as an outer watchdog. |
| About two seconds per tool readiness wait | Avoid leaving a user-visible tool call pending for the whole discovery/initialization period. |

Discovery and initialization are separate phases, so their maximum durations can add up. They happen in the background and do not delay opening Pi or chatting. Tools become available as soon as readiness succeeds, even if that takes only milliseconds.

A call whose short wait expires returns an actionable failure and is **never replayed**. The shared background connection continues, so a later call can succeed. Cancelling a tool's wait does not cancel readiness for other calls.

`/sbx off`, manual sandbox selection, session replacement, and shutdown cancel the previous attempt. Late results cannot override the user's choice or attach to the next session. The worker and readiness observer are disposed; independently running image hooks are not automatically stopped or rerun. Only explicit host mode permits ordinary host execution. Per-call `execution_target: "host"` remains approval-gated even while no sandbox is selected.

## User-visible behavior

- One notification after the initial lookup finds no matching sandbox, explaining that conversation remains available and `/sbx off` enables host execution.
- Footer-only progress for connecting and initializing.
- The normal sandbox-name footer when ready. **No success notification or injected user message.**
- One actionable warning for discovery expiry/error, worker connection loss, or initialization failure. Repeated polls and blocked tool calls do not generate repeated notifications.
- `/sbx` checks again and offers selection; `/sbx on` reconnects to the saved sandbox. Neither command automatically reruns failed image hooks.

Helper stdout and stderr are discarded. Notifications contain a safe failure category, not hook output, environment values, or contents of private logs. Inspect those logs explicitly through the image's documented diagnostics and fix/retry initialization before reconnecting.

## Limits of the signal

This barrier covers **required initialization declared by the image's helper**. It does not certify arbitrary services, installed project dependencies, future health, or every background kit task. For example, an empty `SBX_STARTUP_DIR` opts out even if the kit has other startup work.

Keep required initialization small where possible. A long mandatory hook necessarily delays sandbox tools; readiness must not be bypassed simply to improve a timing metric. Do not remove existing startup capabilities or relabel unfinished mandatory work as ready. Separate optional work only through an intentional image-design change.

A worker connection is not reused across manual selection or session replacement. A disconnected worker cannot authorize host execution. Reconnection establishes a new worker and repeats the image check; stale success must be rejected by the helper's current-boot validation.

## Conformance checklist

Image authors should verify:

- Unset and empty opt-in variables require no helper invocation.
- The observer can start before hooks and returns promptly after their success.
- Prior-boot, missing, and malformed state cannot produce success.
- Failed hooks produce nonzero status without exposing private output.
- Missing helpers fail rather than silently skipping readiness.
- Multiple observers do not rerun hooks or corrupt state.
- Timeout and cancellation terminate observation without replaying initialization.

pi-sbx's local fixture tests cover transport gating, helper invocation, failures, timeouts, early requests, and cancellation. Current-boot state and hook execution semantics remain the image runner's own test responsibility.
