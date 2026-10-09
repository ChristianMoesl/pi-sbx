# pi-sbx

A [Pi](https://pi.dev) extension that keeps the coding agent on the host while executing its shell and filesystem tools inside a Docker `sbx` sandbox.

## Why

Running Pi itself in a sandbox means mounting its configuration, provider credentials, extensions, and session state. `pi-sbx` leaves Pi on the host and routes only tool execution into an isolated sandbox. The project workspace remains a normal SBX mount, so changes made by tools are reflected on the host.

## Requirements

- Pi with Node.js 24 or newer
- To use sandboxing: Docker `sbx` available on the host
- To use sandboxing: an SBX sandbox that directly mounts Pi's current working directory (or a parent directory)
- To use sandboxing: Node.js, Bash, `sh`, `rg`, and `file` in the sandbox image

Sandboxing is enabled by default. If SBX is missing, unavailable, or still being created, routed tools do **not** silently run on the host. Use `/sbx off` to explicitly use Pi's normal host tools; chatting remains available throughout startup.

The extension supports macOS hosts and Pi running inside WSL2 with Windows Docker Sandboxes. Sandboxes must run Linux. WSL2 integration has been tested with `sbx.exe` v0.43.0, using both WSL-filesystem and Windows-drive workspaces. Running Pi directly in native Windows Node.js is not yet supported; run Pi inside WSL instead.

## Install

Install the package globally so the extension is available in every Pi project:

```sh
pi install npm:@christianmoesl/pi-sbx
```

Restart Pi after installation. Confirm the package is registered with `pi list`.

To try it for one Pi process without installing it:

```sh
pi -e npm:@christianmoesl/pi-sbx
```

You can also install directly from GitHub or a local checkout:

```sh
pi install git:github.com/ChristianMoesl/pi-sbx
pi install /absolute/path/to/pi-sbx
```

## Create a sandbox

The Pi agent directory does not need to be mounted. Replace `your-sandbox-image:tag` with a Linux image meeting the requirements above, then create a sandbox:

```sh
sbx create \
  --name my-workspace \
  --template your-sandbox-image:tag \
  shell "$PWD"
```

Start Pi on the host from that workspace:

```sh
pi
```

`pi-sbx` discovers sandboxes using `sbx ls --json`. It keeps sandboxes whose workspace mounts contain Pi's current working directory, preferring a running sandbox and then sorting by name. A stopped sandbox is valid because `sbx exec` starts it automatically when pi-sbx connects in the background. Use direct workspace mounts, not SBX's `--clone` mode. A saved sandbox selection is retained: pi-sbx waits for that name rather than silently choosing a different sandbox if it is missing.

### Windows / WSL2

Install [Docker Sandboxes for Windows](https://docs.docker.com/ai/sandboxes/install/) and install Pi and Node.js inside WSL. WSL interoperability must be enabled, and `sbx.exe` must be on WSL's `PATH`. Check this from your WSL terminal:

```sh
sbx.exe version
sbx.exe ls --json
```

Create a sandbox from your WSL project directory, converting the **host workspace argument** to a Windows path:

```sh
sbx.exe create \
  --name my-workspace \
  --template your-sandbox-image:tag \
  shell "$(wslpath -w "$PWD")"
pi
```

This works for projects in the WSL filesystem (for example `/home/you/project`) and Windows drives (for example `/mnt/c/Users/you/project`). Use the same workspace path spelling when creating the sandbox and starting Pi.

In WSL, pi-sbx prefers a native `sbx` on `PATH`, falling back to `sbx.exe` when no native executable is found. The selected executable is used for both discovery and execution; CLI errors do not cause it to switch installations. To select a particular executable explicitly:

```sh
PI_SBX_EXECUTABLE="$(command -v sbx.exe)" pi
```

`PI_SBX_EXECUTABLE` is an executable path or command name, not a shell command with arguments. Shell aliases are not used.

Windows SBX mounts have different paths inside the sandbox: `C:\Users\you\project` becomes `/c/Users/you/project`, and `\\wsl.localhost\Ubuntu\home\you\project` becomes `/wsl.localhost/Ubuntu/home/you/project`. pi-sbx uses `wslpath` for discovery and translates filesystem-tool paths and working directories. The agent is told the sandbox working directory. Bash and `!` command text is **not** rewritten: use relative paths or Linux sandbox paths in shell commands.

If the footer says **`sbx: host (disabled)`**, host execution was explicitly enabled. Discovery or initialization failures never switch to this mode. Check `sbx.exe ls --json` and run `/sbx` to refresh discovery, or `/sbx on` to reconnect.

## Usage

The selected sandbox appears in Pi's footer:

```text
sbx: my-workspace
```

Run `/sbx` to refresh discovery and select a sandbox. With no matching sandbox and sandboxing enabled, this restarts background discovery. Select **Host (disable sandboxing)** in that menu, or run `/sbx off`, to disable sandboxing for the current session. Run `/sbx on` to reconnect to the previously selected sandbox, or discover one if none was selected.

### Using `/sbx` during an agent turn

`/sbx`, `/sbx on`, and `/sbx off` work while the agent is thinking or executing tools; they do not wait for the turn to finish or abort the agent turn. The menu appears after sandbox discovery, with **Host (disable sandboxing)** last. Opening or dismissing the menu leaves the current execution environment unchanged.

Selecting an environment or running `/sbx on` or `/sbx off` takes effect immediately. This closes the previous sandbox worker: in-flight sandbox calls fail, may have partially executed, and are **never replayed or moved to the host**. Subsequent calls use the new environment and its normal readiness checks. Already-running host calls are not cancelled or moved into a sandbox.

A newer `/sbx` command or a session change cancels an older discovery/menu interaction, so a stale selection cannot override it.

### Starting before a sandbox exists

Pi starts without waiting for discovery or image initialization. pi-sbx checks immediately and, if no matching sandbox exists, polls roughly once per second for up to one minute. It emits one informational notification (not a warning):

> Waiting for a sandbox for this workspace. You can keep chatting. Use /sbx off to run tools on the host.

When a sandbox appears, pi-sbx connects its worker in the background and honors the image's optional startup readiness contract. Tools become available **as soon as it is ready**, not after a fixed delay. The footer shows waiting, connecting, initializing, the ready sandbox name, or failure. **Successful discovery/readiness produces no notification.** Discovery expiry, discovery errors, and initialization failures produce one actionable warning per attempt.

A routed tool requested before readiness waits at most about **two seconds** for preparation, then fails with an explanation if still unavailable. It is not queued for later execution. Abort cancels that call's wait, not shared preparation. Unrelated trusted host-extension tools and the existing discovered-skill read exception remain available.

`/sbx off` cancels discovery/connection and enables host tools; a late result cannot select a sandbox afterward. Explicit host-targeted calls can also be approved individually while waiting. On failure, tools stay unavailable until retry or an explicit host choice. Use `/sbx` to inspect/select/retry, or `/sbx on` to restart connection to the saved selection. Fixing a failed image hook is the image's responsibility; pi-sbx never reruns hooks itself.

**Behavior change:** previous versions automatically fell back to host tools on missing SBX or discovery failure. They also sometimes persisted that fallback, so an old `hostFallback` session entry is not proof of user consent. Those old host-mode entries are no longer restored: use `/sbx off` once after upgrading if host execution is intended. New explicit host choices are persisted and restored normally; saved sandbox names and conversation history are unchanged.

### Sandbox restarts and replacement

Changing workspace mounts can require removing and recreating a sandbox under the **same name**. This terminates pi-sbx's worker even though Pi itself stays open on the host.

After a previously ready worker loses its connection, pi-sbx automatically rediscovers that same sandbox and creates a fresh worker with the current mount mappings. A new 60-second discovery/retry window tolerates the sandbox being temporarily absent, discovery errors, and races between discovery and `sbx exec`. Each worker connection and image readiness check retains its normal timeout; a connection begun within the retry window can finish afterward. Image-readiness and protocol failures remain terminal rather than being retried automatically.

The footer shows reconnection progress, with one informational disconnect notice and no success notification. If recovery expires or initialization fails, one actionable warning is shown. Use `/sbx on` to retry or `/sbx` to select another sandbox. `/sbx off`, selection, reload/session replacement, and shutdown cancel recovery.

**Interrupted calls fail and are never replayed.** They may already have made partial changes; inspect the result before retrying a mutation. Calls made while reconnecting use the normal short readiness wait. Recovery never chooses a different sandbox name or enables host execution.

For versions without automatic reconnection, run **`/sbx on` after the replacement sandbox is ready** to reconnect without restarting Pi. Reload Pi separately when needed to refresh repository instructions and skills.

### Optional image startup readiness

An image can opt in by setting a nonempty `SBX_STARTUP_DIR` **inside the sandbox** and providing this executable on its sandbox `PATH`:

```sh
sandbox-startup wait --timeout 60
```

The pi-sbx worker runs that command before reporting ready. Exit zero enables sandbox tools; a missing helper, failure, or timeout keeps them unavailable. With an unset/empty variable, the worker uses normal transport readiness without invoking the helper. Pi-sbx does not execute the directory's scripts or interpret the helper's private status files.

See **[the image readiness contract](docs/readiness.md)** for lifecycle guarantees, image/kit setup, timeout and cancellation semantics, diagnostics, and conformance checks. The contract is independent of any workspace launcher.

The extension routes these built-in tools through `sbx exec`:

- `bash`
- `read` (except read-only access to skills discovered by Pi)
- `write`
- `edit`
- `grep`
- `find`
- `ls`
- interactive `!` commands

The routed built-in tools also accept an optional `execution_target` argument:

```json
{
  "path": "/path/only/available/on/the/host",
  "execution_target": "host"
}
```

The default target is `sandbox`. While a sandbox is active, every `host` call to a routed built-in tool shows its exact operation and requires user approval. Approval applies only to that unchanged tool call; it does not disable the sandbox or approve later calls. Host requests are blocked when no interactive approval UI is available. Approval is also required while discovery or initialization is pending or failed. Only explicit host mode (`/sbx off`) skips the per-call approval.

Extension-provided tools are not routed through SBX and run on the host by default without pi-sbx approval. At the start of each agent turn, pi-sbx adds up to the first 10 active host tool names to the system prompt so the model can distinguish them from sandboxed tools.

If no matching sandbox exists—or `sbx` cannot be discovered—routed tools and interactive `!` commands remain blocked. `!` commands use the same short readiness wait and never fall through to host execution. Explicit `/sbx off` enables normal host `!` commands.

## Startup notifications

- **Host-provided packages in `dependencies` (`typebox`):** update `pi-sbx` to a version that declares these as `"*"` peer dependencies, then reload Pi.
- **Waiting for a sandbox (info):** Pi is usable for conversation; routed tools are waiting for discovery/readiness. Use `/sbx off` if host execution is intended.
- **Discovery expired/failed:** tools remain blocked. Fix SBX access and use `/sbx` to check again, or explicitly choose host mode.
- **Initialization failed:** inspect the image's startup configuration and private logs. A configured `SBX_STARTUP_DIR` requires `sandbox-startup` on the sandbox PATH. Fix/retry image initialization, then reconnect with `/sbx on`.
- **`pi-mcp-adapter` replaces built-in `mcp`:** this is a Pi configuration conflict, not a `pi-sbx` error. Use `pi config` to keep only one MCP implementation enabled. If switching to built-in MCP, migrate and verify your server configuration before removing the adapter.

## Security model

- Pi and model-provider communication remain on the host.
- Built-in shell and filesystem operations run in the selected sandbox.
- The `read` tool may read skills discovered by Pi from the host, regardless of whether they came from global, project, package, settings, or CLI locations. Directory-based skills include supporting files below their base directory; standalone Markdown skills include only the discovered file. Canonical-path checks reject traversal and symlink escapes from skill directories.
- Host environment variables are not forwarded to sandboxed shell commands.
- An approved `execution_target: "host"` call runs with Pi's normal host permissions and environment. Treat the confirmation as a sandbox escape authorization.
- Extension-provided tools execute in Pi's host process and are not intercepted or approved by pi-sbx. Only install trusted extensions and review their tool behavior.
- When no sandbox is available, routed tools fail closed. Host execution requires an explicit per-call approval or `/sbx off`; timeout never grants host access.
- The image readiness helper is trusted image code, executed inside the sandbox. Its stdout/stderr is discarded rather than copied into the model context or notifications.
- Do not combine `pi-sbx` with another extension that overrides the same built-in tool names.

Provide required secrets through SBX policy or secret mechanisms instead of exposing the host Pi agent directory.

## Update and remove

Update installed Pi packages:

```sh
pi update --extensions
```

Remove the npm package:

```sh
pi remove npm:@christianmoesl/pi-sbx
```

For a Git installation, use `pi remove git:github.com/ChristianMoesl/pi-sbx` instead.

## Development

Use Node.js 24+ and the pnpm version pinned in `package.json` (currently **12.4.2**). With Corepack installed, run `corepack enable` once to enable its package-manager shims.

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm pack --dry-run
```

Commit dependency changes to `pnpm-lock.yaml`; do not generate an npm lockfile. `pnpm-workspace.yaml` records reviewed dependency-script decisions, leaving unreviewed install scripts blocked.

Pi executes the TypeScript extension directly; no build step is required. Pi supplies `@earendil-works/pi-coding-agent` and `typebox` at runtime, so both are declared as `"*"` peer dependencies. Their development dependencies are only for local typechecking and tests; do not move them into `dependencies` or bundle them.

An optional end-to-end test exercises all routed tools and `!` commands against an existing sandbox. Set `PI_SBX_TEST_WORKSPACE` to a directly mounted host directory (in WSL, use its Linux path):

```sh
PI_SBX_TEST_WORKSPACE=/path/to/workspace \
  node --experimental-strip-types --import ./test/setup.ts --test test/sbx-integration.test.ts
```

The unit suite uses local fixture workers and fake discovery, including delayed startup, failure, cancellation, host-mode races, sandbox replacement, and worker loss during a mutation (without replay); it never creates real sandboxes.

The optional integration test waits for worker/image readiness, then creates and removes a unique temporary subdirectory in that workspace. It does not create or remove sandboxes. Without this variable, the integration test is skipped.

## Releasing

The package is published as [`@christianmoesl/pi-sbx`](https://www.npmjs.com/package/@christianmoesl/pi-sbx). Pushing an annotated version tag starts [the release pipeline](.github/workflows/stage-publish.yml). CI validates and **stages** the package on npm, then creates a **draft GitHub release** with generated notes. A maintainer must approve the npm stage with 2FA before making the release public.

### One-time npm setup

Use npm **11.17.0 or newer**, log in with `npm login`, and enable 2FA on your npm account. Configure this existing package's trusted publisher:

```sh
npm trust github @christianmoesl/pi-sbx \
  --repo ChristianMoesl/pi-sbx \
  --file stage-publish.yml \
  --allow-stage-publish
```

Grant **staged publishing only**, not `--allow-publish`. The workflow uses GitHub OIDC; no `NPM_TOKEN` secret is needed. If a trusted publisher already exists, inspect it with `npm trust list @christianmoesl/pi-sbx` and update it deliberately rather than blindly replacing it. Package access controls can also require 2FA and disallow bypass tokens; changing those controls is a separate maintainer decision.

### Start a release

Install dependencies with `pnpm install --frozen-lockfile`, then run from a clean, current `main` checkout with Git push access:

```sh
pnpm run release <version>
# Example:
pnpm run release 0.6.4
```

The release script requires an explicit semantic version. It checks that `main` is current and the tag does not exist, runs `pnpm run check` and a package dry run, bumps the version with `pnpm version`, commits `package.json` and any `pnpm-lock.yaml` changes, pushes `main`, and creates/pushes an annotated `v<version>` tag. It **does not publish locally**, create a GitHub release locally, or require npm/GitHub CLI login.

The tag push triggers three jobs:

1. **Validate:** require an annotated tag reachable from `origin/main`, matching the tagged package version; install frozen dependencies, run checks, dry-run packing, and upload the packed tarball.
2. **Stage:** download and verify that exact tarball's SHA-256, then run `npm stage publish --provenance`. Only this job has `id-token: write`; it does not install project dependencies or run package lifecycle scripts.
3. **Release:** create a draft GitHub release with generated notes. Only this job has `contents: write`; existing drafts or published releases are preserved on retry.

Stable tags use the npm `latest` dist-tag. Prerelease tags (for example `v0.7.0-beta.1`) use `next` and mark the GitHub draft as a prerelease. Manual dispatch can select a different npm dist-tag; prereleases cannot use `latest`.

### Approve and publish

Inspect the stage ID from the staging job's log or list stages locally:

```sh
npm stage list @christianmoesl/pi-sbx
npm stage view <stage-id>
npm stage download <stage-id>  # optional: inspect the tarball
npm stage approve <stage-id>   # requires 2FA; publishes on npm
# Or reject a bad stage (also requires 2FA):
npm stage reject <stage-id>
```

After confirming publication on npm, publish the draft in GitHub's UI or with an authenticated GitHub CLI:

```sh
gh release edit v<version> --draft=false
```

CI does not approve npm stages or publish GitHub drafts automatically. Creating or publishing a GitHub release does not itself publish to npm.

### Recovery

- If the version commit or tag push fails, inspect the local commit/tag and remote state, then finish the pushes manually. Do not rerun the release script for an already-created version tag.
- If validation fails, nothing was staged. Correct the cause before retrying.
- If staging fails, check `npm stage list` and `npm view @christianmoesl/pi-sbx@<version> version` first: a request can succeed even if its response was lost. Retry staging only if the version is neither staged nor published.
- If only GitHub release creation fails, use **Re-run failed jobs**; this does not repeat the successful staging job.
- Packed artifacts are immutable, named by run ID and validation attempt, and retained for 14 days. Failed-job retries download the artifact produced by validation, even when the retry's attempt number changes. Runs for the same tag are serialized without cancelling an in-progress release.

To start the pipeline for an existing tag that has **not** already been staged or published, dispatch it from `main`:

```sh
gh workflow run stage-publish.yml --ref main \
  -f release_tag=v0.6.4 -f npm_tag=latest
```

The npm dist-tag is immutable once staged. To change it, reject the stage and re-stage with the desired tag. A pending stage reserves its package version; a published version can never be reused. Do not retry a full pipeline against an existing stage: approve/reject it first. If necessary, finish a missing GitHub draft manually with `gh release create v<version> --draft --verify-tag --generate-notes`.

### Direct local publishing alternative

`pnpm run publish:npm [--dry-run]` remains available as an explicit alternative. It requires a clean `main`, the release tag and `origin/main` pointing at `HEAD`, runs validation, checks npm authentication, and prompts before publishing directly. **Do not use it for a pending staged version.** Once configured, tag pushes start CI staging automatically, so do not mix the local and CI publishing paths for the same version.

## License

MIT
