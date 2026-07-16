# pi-sbx

A [Pi](https://pi.dev) extension that keeps the coding agent on the host while executing its shell and filesystem tools inside a Docker `sbx` sandbox.

## Why

Running Pi itself in a sandbox means mounting its configuration, provider credentials, extensions, and session state. `pi-sbx` leaves Pi on the host and routes only tool execution into an isolated sandbox. The project workspace remains a normal SBX mount, so changes made by tools are reflected on the host.

## Requirements

- Pi with Node.js 24 or newer
- To use sandboxing: Docker `sbx` available on the host
- To use sandboxing: an SBX sandbox that mounts Pi's current working directory at the same absolute path
- To use sandboxing: Node.js, `sh`, `rg`, and `file` in the sandbox image

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
- `read`
- `write`
- `edit`
- `grep`
- `find`
- `ls`
- interactive `!` commands

If no matching sandbox exists—or `sbx` cannot be discovered—the extension falls back to Pi's normal host tools. In host-fallback mode, third-party tools are not blocked and interactive `!` commands also run normally on the host.

## Security model

- Pi and model-provider communication remain on the host.
- Built-in shell and filesystem operations run in the selected sandbox.
- Host environment variables are not forwarded to sandboxed shell commands.
- While an SBX sandbox is selected, unknown third-party tools are blocked because Pi cannot transparently move arbitrary extension implementations into SBX.
- When no sandbox is available, Pi's normal host-tool behavior is preserved, including third-party tools.
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

## License

MIT
