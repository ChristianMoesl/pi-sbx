# pi-sbx

A [Pi](https://pi.dev) extension that keeps the coding agent on the host while executing its shell and filesystem tools inside a Docker `sbx` sandbox.

## Why

Running Pi itself in a sandbox means mounting its configuration, provider credentials, extensions, and session state. `pi-sbx` leaves Pi on the host and routes only tool execution into an isolated sandbox. The project workspace remains a normal SBX mount, so changes made by tools are reflected on the host.

## Requirements

- Pi with Node.js 24 or newer
- To use sandboxing: Docker `sbx` available on the host
- To use sandboxing: an SBX sandbox that mounts Pi's current working directory at the same absolute path
- To use sandboxing: Node.js, Bash, `sh`, `rg`, and `file` in the sandbox image

Without SBX, the extension remains usable and leaves Pi's standard host tools unchanged.

The extension is currently designed and tested for macOS hosts and Linux SBX sandboxes.

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

`pi-sbx` discovers sandboxes using `sbx ls --json`. It keeps sandboxes whose workspace mounts contain Pi's current working directory, preferring a running sandbox and then sorting by name. A stopped sandbox is valid because `sbx exec` starts it automatically.

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
