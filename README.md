# pi-sbx

A [Pi](https://pi.dev) extension that keeps the coding agent on the host while executing its shell and filesystem tools inside a Docker `sbx` sandbox.

## Why

Running Pi itself in a sandbox means mounting its configuration, provider credentials, extensions, and session state. `pi-sbx` leaves Pi on the host and routes only tool execution into an isolated sandbox. The project workspace remains a normal SBX mount, so changes made by tools are reflected on the host.

## Requirements

- Pi with Node.js 24 or newer
- Docker `sbx` available on the host
- An SBX sandbox that mounts Pi's current working directory at the same absolute path
- `sh`, `python3`, `rg`, and `file` in the sandbox image

The extension is currently designed and tested for macOS hosts and Linux SBX sandboxes.

## Install

Install globally from GitHub so the extension is available in every Pi project:

```sh
pi install git:github.com/ChristianMoesl/pi-sbx
```

Restart Pi after installation. Confirm the package is registered with:

```sh
pi list
```

To try it for one Pi process without installing it:

```sh
pi -e git:github.com/ChristianMoesl/pi-sbx
```

For local development, point Pi directly at a checkout:

```sh
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

Run `/sbx` to refresh discovery and switch the sandbox used for tool execution.

The extension routes these built-in tools through `sbx exec`:

- `bash`
- `read`
- `write`
- `edit`
- `grep`
- `find`
- `ls`
- interactive `!` commands

If no matching sandbox exists, tool execution fails closed.

## Security model

- Pi and model-provider communication remain on the host.
- Built-in shell and filesystem operations run in the selected sandbox.
- Host environment variables are not forwarded to sandboxed shell commands.
- Unknown third-party tools are blocked because Pi cannot transparently move arbitrary extension implementations into SBX.
- Do not combine `pi-sbx` with another extension that overrides the same built-in tool names.

Provide required secrets through SBX policy or secret mechanisms instead of exposing the host Pi agent directory.

## Update and remove

Update an unpinned Git installation:

```sh
pi update --extensions
```

Remove the package:

```sh
pi remove git:github.com/ChristianMoesl/pi-sbx
```

## Development

```sh
npm install
npm run check
npm pack --dry-run
```

Pi executes the TypeScript extension directly; no build step is required.

## License

MIT
