# pi-sbx

A [Pi](https://pi.dev) extension that keeps the coding agent on the host while executing its shell and filesystem tools inside a Docker `sbx` sandbox.

## Why

Running Pi itself in a sandbox means mounting its configuration, provider credentials, extensions, and session state. `pi-sbx` leaves Pi on the host and routes only tool execution into an isolated sandbox. The project workspace remains a normal SBX mount, so changes made by tools are reflected on the host.

## Requirements

- Pi with Node.js 24 or newer
- To use sandboxing: Docker `sbx` available on the host
- To use sandboxing: an SBX sandbox that directly mounts Pi's current working directory (or a parent directory)
- To use sandboxing: Node.js, Bash, `sh`, `rg`, and `file` in the sandbox image

Without SBX, the extension remains usable and leaves Pi's standard host tools unchanged.

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

The Pi agent directory does not need to be mounted. A minimal sandbox can be created with:

```sh
sbx create \
  --name my-workspace \
  --template christianmoesl/radar-sandbox:latest \
  shell "$PWD"
```

Start Pi on the host from that workspace:

```sh
pi
```

`pi-sbx` discovers sandboxes using `sbx ls --json`. It keeps sandboxes whose workspace mounts contain Pi's current working directory, preferring a running sandbox and then sorting by name. A stopped sandbox is valid because `sbx exec` starts it automatically. Use direct workspace mounts, not SBX's `--clone` mode.

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
  --template christianmoesl/radar-sandbox:latest \
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

If the footer says **`sbx: host fallback`**, tools are running on the host, not in a sandbox. Check `sbx.exe ls --json` and run `/sbx` to refresh discovery.

## Usage

The selected sandbox appears in Pi's footer:

```text
sbx: my-workspace
```

Run `/sbx` to refresh discovery and switch the sandbox used for tool execution. Select **Host (disable sandboxing)** in that menu, or run `/sbx off`, to disable sandboxing for the current session. Run `/sbx on` to re-enable the previously selected sandbox.

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

The default target is `sandbox`. While a sandbox is active, every `host` call to a routed built-in tool shows its exact operation and requires user approval. Approval applies only to that unchanged tool call; it does not disable the sandbox or approve later calls. Host requests are blocked when no interactive approval UI is available. In host-fallback mode the tools already run on the host, so no approval is requested.

Extension-provided tools are not routed through SBX and run on the host by default without pi-sbx approval. At the start of each agent turn, pi-sbx adds up to the first 10 active host tool names to the system prompt so the model can distinguish them from sandboxed tools.

If no matching sandbox exists—or `sbx` cannot be discovered—the extension falls back to Pi's normal host tools. Interactive `!` commands also run normally on the host.

## Security model

- Pi and model-provider communication remain on the host.
- Built-in shell and filesystem operations run in the selected sandbox.
- The `read` tool may read skills discovered by Pi from the host, regardless of whether they came from global, project, package, settings, or CLI locations. Directory-based skills include supporting files below their base directory; standalone Markdown skills include only the discovered file. Canonical-path checks reject traversal and symlink escapes from skill directories.
- Host environment variables are not forwarded to sandboxed shell commands.
- An approved `execution_target: "host"` call runs with Pi's normal host permissions and environment. Treat the confirmation as a sandbox escape authorization.
- Extension-provided tools execute in Pi's host process and are not intercepted or approved by pi-sbx. Only install trusted extensions and review their tool behavior.
- When no sandbox is available, Pi's normal host-tool behavior is preserved.
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

```sh
npm install
npm run check
npm pack --dry-run
```

Pi executes the TypeScript extension directly; no build step is required.

An optional end-to-end test exercises all routed tools and `!` commands against an existing sandbox. Set `PI_SBX_TEST_WORKSPACE` to a directly mounted host directory (in WSL, use its Linux path):

```sh
PI_SBX_TEST_WORKSPACE=/path/to/workspace \
  node --experimental-strip-types --import ./test/setup.ts --test test/sbx-integration.test.ts
```

The test creates and removes a unique temporary subdirectory in that workspace. It does not create or remove sandboxes. Without this variable, the integration test is skipped.

## Releasing

The package is published as [`@christianmoesl/pi-sbx`](https://www.npmjs.com/package/@christianmoesl/pi-sbx). Publishing is performed manually from a local checkout; creating a GitHub release does not publish anything automatically.

Log in to npm first (for example, with `npm login`) and authenticate the GitHub CLI with `gh auth login`, then run:

```sh
npm run release -- <version>
```

For example:

```sh
npm run release -- 0.4.1
```

The release script requires a clean, current `main` checkout and an explicit semantic version. It verifies npm and GitHub CLI authentication and that the release tag does not already exist before changing files. It then updates `package.json` and `package-lock.json`, commits and pushes `main`, creates and pushes an annotated `v<version>` tag, and runs the publish script.

The publish script verifies that `origin/main` and the release tag point to `HEAD`, runs the checks and package dry run, verifies npm authentication again, and asks for final confirmation before publishing the public package. After a successful npm publish, the release script always creates the GitHub release with generated notes.

Each npm version can only be published once. If publication fails, check whether that version exists on npm before retrying.

## License

MIT
