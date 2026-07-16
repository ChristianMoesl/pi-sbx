import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type BashOperations,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	DEFAULT_MAX_BYTES,
	type EditOperations,
	type FindOperations,
	formatSize,
	type GrepToolDetails,
	type GrepToolInput,
	type LsOperations,
	type ReadOperations,
	truncateHead,
	truncateLine,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { parseMatchingSandboxes, type SbxSandbox } from "./discovery.ts";
import { SbxTransport, type SbxExecOptions, type SbxExecResult } from "./transport.ts";

const STATUS_ID = "pi-sbx";
const STATE_ENTRY = "pi-sbx-selection";
const ROUTED_TOOLS = new Set(["bash", "edit", "find", "grep", "ls", "read", "write"]);
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 60;
const DEFAULT_GREP_LIMIT = 100;

interface SelectionState {
	name?: string;
	hostFallback?: boolean;
}

function commandError(command: string[], result: SbxExecResult): Error {
	const detail = result.stderr.toString().trim() || result.stdout.toString().trim();
	return new Error(detail || `${command[0] ?? "command"} exited with code ${result.exitCode}`);
}

async function successfulExec(
	transport: SbxTransport,
	cwd: string,
	command: string[],
	options?: SbxExecOptions,
): Promise<SbxExecResult> {
	const result = await transport.execute(cwd, command, options);
	if (result.exitCode !== 0) throw commandError(command, result);
	return result;
}

function createSbxReadOps(transport: SbxTransport, cwd: string): ReadOperations {
	return {
		readFile: async (filePath) =>
			(await successfulExec(transport, cwd, ["sh", "-c", 'cat -- "$1"', "sbx-read", filePath])).stdout,
		access: async (filePath) => {
			await successfulExec(transport, cwd, ["sh", "-c", 'test -r "$1"', "sbx-read", filePath]);
		},
		detectImageMimeType: async (filePath) => {
			const result = await transport.execute(cwd, ["file", "--mime-type", "-b", filePath]);
			if (result.exitCode !== 0) return null;
			const mimeType = result.stdout.toString().trim();
			return ["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp"].includes(mimeType)
				? mimeType
				: null;
		},
	};
}

function createSbxWriteOps(transport: SbxTransport, cwd: string): WriteOperations {
	return {
		mkdir: async (dirPath) => {
			await successfulExec(transport, cwd, ["mkdir", "-p", "--", dirPath]);
		},
		writeFile: async (filePath, content) => {
			await successfulExec(transport, cwd, ["sh", "-c", 'cat > "$1"', "sbx-write", filePath], { input: content });
		},
	};
}

function createSbxEditOps(transport: SbxTransport, cwd: string): EditOperations {
	const read = createSbxReadOps(transport, cwd);
	const write = createSbxWriteOps(transport, cwd);
	return {
		readFile: read.readFile,
		writeFile: write.writeFile,
		access: async (filePath) => {
			await successfulExec(transport, cwd, ["sh", "-c", 'test -r "$1" && test -w "$1"', "sbx-edit", filePath]);
		},
	};
}

function createSbxBashOps(transport: SbxTransport): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout }) => {
			const result = await transport.execute(cwd, ["sh", "-lc", command], {
				onStdout: onData,
				onStderr: onData,
				signal,
				timeoutSeconds: timeout ?? 0,
			});
			return { exitCode: result.exitCode };
		},
	};
}

function createSbxLsOps(transport: SbxTransport, cwd: string): LsOperations {
	const directoryCache = new Map<string, boolean>();
	return {
		exists: async (filePath) => {
			const result = await transport.execute(cwd, ["sh", "-c", 'test -e "$1"', "sbx-ls", filePath]);
			return result.exitCode === 0;
		},
		stat: async (filePath) => {
			let isDirectory = directoryCache.get(filePath);
			if (isDirectory === undefined) {
				const result = await transport.execute(cwd, ["sh", "-c", 'test -d "$1"', "sbx-ls", filePath]);
				isDirectory = result.exitCode === 0;
				directoryCache.set(filePath, isDirectory);
			}
			return { isDirectory: () => isDirectory };
		},
		readdir: async (dirPath) => {
			const script = [
				'root=$1',
				'for entry in "$root"/* "$root"/.[!.]* "$root"/..?*; do',
				'  if [ -e "$entry" ] || [ -L "$entry" ]; then',
				'    name=${entry##*/}',
				'    if [ -d "$entry" ]; then kind=d; else kind=f; fi',
				'    printf "%s\\0%s\\0" "$name" "$kind"',
				'  fi',
				'done',
			].join("\n");
			const result = await successfulExec(transport, cwd, ["sh", "-c", script, "sbx-ls", dirPath]);
			const fields = result.stdout.toString().split("\0");
			fields.pop();
			const entries: Array<{ name: string; directory: boolean }> = [];
			for (let index = 0; index < fields.length; index += 2) {
				const name = fields[index];
				if (name === undefined) continue;
				entries.push({ name, directory: fields[index + 1] === "d" });
			}
			for (const entry of entries) directoryCache.set(path.join(dirPath, entry.name), entry.directory);
			return entries.map((entry) => entry.name);
		},
	};
}

function matchesToolGlob(relativePath: string, pattern: string): boolean {
	const normalized = pattern.replaceAll("\\", "/");
	if (normalized.includes("/")) {
		return path.posix.matchesGlob(relativePath, normalized) || path.posix.matchesGlob(relativePath, `**/${normalized}`);
	}
	return path.posix.matchesGlob(path.posix.basename(relativePath), normalized);
}

function createSbxFindOps(transport: SbxTransport, sessionCwd: string): FindOperations {
	return {
		exists: async (filePath) => {
			const result = await transport.execute(sessionCwd, ["sh", "-c", 'test -e "$1"', "sbx-find", filePath]);
			return result.exitCode === 0;
		},
		glob: async (pattern, cwd, options) => {
			const result = await transport.execute(cwd, [
				"rg",
				"--files",
				"--hidden",
				"--glob",
				"!.git",
				"--glob",
				"!**/.git/**",
				"--glob",
				"!**/node_modules/**",
				cwd,
			]);
			if (result.exitCode !== 0 && result.exitCode !== 1) throw commandError(["rg"], result);
			const matches: string[] = [];
			for (const filePath of result.stdout.toString().split("\n")) {
				if (!filePath) continue;
				const relativePath = path.relative(cwd, filePath).replaceAll("\\", "/");
				if (matchesToolGlob(relativePath, pattern)) matches.push(filePath);
				if (matches.length >= options.limit) break;
			}
			return matches;
		},
	};
}

function formatGrepPath(searchPath: string, filePath: string, isDirectory: boolean): string {
	if (!isDirectory) return path.basename(filePath);
	const relativePath = path.relative(searchPath, filePath).replaceAll("\\", "/");
	return relativePath && !relativePath.startsWith("..") ? relativePath : filePath;
}

async function executeSbxGrep(
	transport: SbxTransport,
	cwd: string,
	params: GrepToolInput,
	signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: GrepToolDetails | undefined }> {
	const searchPath = path.resolve(cwd, params.path ?? ".");
	const directoryResult = await transport.execute(cwd, ["sh", "-c", 'test -d "$1"', "sbx-grep", searchPath], {
		signal,
	});
	const isDirectory = directoryResult.exitCode === 0;
	const contextLines = params.context && params.context > 0 ? params.context : 0;
	const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
	const args = ["rg", "--json", "--line-number", "--color=never", "--hidden"];
	if (params.ignoreCase) args.push("--ignore-case");
	if (params.literal) args.push("--fixed-strings");
	if (params.glob) args.push("--glob", params.glob);
	if (contextLines > 0) args.push("--context", String(contextLines));
	args.push("--", params.pattern, searchPath);
	const result = await transport.execute(cwd, args, { signal, timeoutSeconds: DEFAULT_COMMAND_TIMEOUT_SECONDS });
	if (result.exitCode !== 0 && result.exitCode !== 1) throw commandError(args, result);

	type Record = { filePath: string; line: number; text: string; match: boolean };
	const records = new Map<string, Record>();
	const matches: Record[] = [];
	for (const line of result.stdout.toString().split("\n")) {
		if (!line) continue;
		let event: { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
		try {
			event = JSON.parse(line) as typeof event;
		} catch {
			continue;
		}
		if (event.type !== "match" && event.type !== "context") continue;
		const filePath = event.data?.path?.text;
		const lineNumber = event.data?.line_number;
		const text = event.data?.lines?.text;
		if (!filePath || typeof lineNumber !== "number" || typeof text !== "string") continue;
		const record = { filePath, line: lineNumber, text: text.replace(/\r?\n$/, ""), match: event.type === "match" };
		records.set(`${filePath}\0${lineNumber}`, record);
		if (record.match) matches.push(record);
	}

	if (matches.length === 0) return { content: [{ type: "text", text: "No matches found" }], details: undefined };

	const outputLines: string[] = [];
	let linesTruncated = false;
	for (const match of matches.slice(0, effectiveLimit)) {
		const start = contextLines > 0 ? Math.max(1, match.line - contextLines) : match.line;
		const end = contextLines > 0 ? match.line + contextLines : match.line;
		for (let lineNumber = start; lineNumber <= end; lineNumber++) {
			const record = records.get(`${match.filePath}\0${lineNumber}`);
			if (!record) continue;
			const truncated = truncateLine(record.text.replace(/\r/g, ""));
			if (truncated.wasTruncated) linesTruncated = true;
			const separator = lineNumber === match.line ? ":" : "-";
			outputLines.push(`${formatGrepPath(searchPath, match.filePath, isDirectory)}${separator}${lineNumber}${separator} ${truncated.text}`);
		}
	}

	const truncation = truncateHead(outputLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
	const details: GrepToolDetails = {};
	const notices: string[] = [];
	if (matches.length > effectiveLimit) {
		details.matchLimitReached = effectiveLimit;
		notices.push(`${effectiveLimit} matches limit reached`);
	}
	if (linesTruncated) {
		details.linesTruncated = true;
		notices.push("long lines truncated");
	}
	if (truncation.truncated) {
		details.truncation = truncation;
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	}
	const output = notices.length > 0 ? `${truncation.content}\n\n[${notices.join(". ")}]` : truncation.content;
	return { content: [{ type: "text", text: output }], details: Object.keys(details).length > 0 ? details : undefined };
}

export default function piSbxExtension(pi: ExtensionAPI) {
	const cwd = process.cwd();
	const localRead = createReadTool(cwd);
	const localWrite = createWriteTool(cwd);
	const localEdit = createEditTool(cwd);
	const localBash = createBashTool(cwd);
	const localLs = createLsTool(cwd);
	const localFind = createFindTool(cwd);
	const localGrep = createGrepTool(cwd);
	let sandboxes: SbxSandbox[] = [];
	let selectedName: string | undefined;
	let sandboxingEnabled = true;
	let transport: SbxTransport | undefined;
	let transportSandbox: string | undefined;

	function disposeTransport(): void {
		transport?.dispose();
		transport = undefined;
		transportSandbox = undefined;
	}

	function selectedTransport(): SbxTransport | undefined {
		const sandbox = selectedSandbox();
		if (!sandbox) {
			disposeTransport();
			return undefined;
		}
		if (!transport || transportSandbox !== sandbox) {
			disposeTransport();
			transport = new SbxTransport(sandbox, cwd);
			transportSandbox = sandbox;
		}
		return transport;
	}

	function restoredSelection(ctx: ExtensionContext): SelectionState | undefined {
		let restored: SelectionState | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
			const data = entry.data as SelectionState | undefined;
			if (typeof data?.name === "string") restored = { name: data.name };
			else if (data?.hostFallback === true) restored = { hostFallback: true };
		}
		return restored;
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (sandboxingEnabled && selectedName) {
			ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("muted", `sbx: ${selectedName}`));
		} else {
			ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("warning", "sbx: host fallback"));
		}
	}

	async function discover(ctx: ExtensionContext): Promise<SbxSandbox[]> {
		const result = await pi.exec("sbx", ["ls", "--json"], { timeout: 10_000 });
		if (result.code !== 0) {
			throw new Error(result.stderr.trim() || `sbx ls --json exited with code ${result.code}`);
		}
		sandboxes = parseMatchingSandboxes(result.stdout, cwd);
		if (selectedName && !sandboxes.some((sandbox) => sandbox.name === selectedName)) {
			selectedName = undefined;
			disposeTransport();
		}
		updateStatus(ctx);
		return sandboxes;
	}

	function selectedSandbox(): string | undefined {
		return sandboxingEnabled ? selectedName : undefined;
	}

	function useHostFallback(ctx: ExtensionContext): void {
		sandboxingEnabled = false;
		disposeTransport();
		pi.appendEntry<SelectionState>(STATE_ENTRY, { hostFallback: true });
		updateStatus(ctx);
	}

	pi.registerTool({
		...localRead,
		label: "read (sbx/host)",
		async execute(id, params, signal, onUpdate) {
			const activeTransport = selectedTransport();
			if (!activeTransport) return localRead.execute(id, params, signal, onUpdate);
			return createReadTool(cwd, { operations: createSbxReadOps(activeTransport, cwd) }).execute(
				id,
				params,
				signal,
				onUpdate,
			);
		},
	});
	pi.registerTool({
		...localWrite,
		label: "write (sbx/host)",
		async execute(id, params, signal, onUpdate) {
			const activeTransport = selectedTransport();
			if (!activeTransport) return localWrite.execute(id, params, signal, onUpdate);
			return createWriteTool(cwd, { operations: createSbxWriteOps(activeTransport, cwd) }).execute(
				id,
				params,
				signal,
				onUpdate,
			);
		},
	});
	pi.registerTool({
		...localEdit,
		label: "edit (sbx/host)",
		async execute(id, params, signal, onUpdate) {
			const activeTransport = selectedTransport();
			if (!activeTransport) return localEdit.execute(id, params, signal, onUpdate);
			return createEditTool(cwd, { operations: createSbxEditOps(activeTransport, cwd) }).execute(
				id,
				params,
				signal,
				onUpdate,
			);
		},
	});
	pi.registerTool({
		...localBash,
		label: "bash (sbx/host)",
		async execute(id, params, signal, onUpdate) {
			const activeTransport = selectedTransport();
			if (!activeTransport) return localBash.execute(id, params, signal, onUpdate);
			return createBashTool(cwd, { operations: createSbxBashOps(activeTransport) }).execute(
				id,
				params,
				signal,
				onUpdate,
			);
		},
	});
	pi.registerTool({
		...localLs,
		label: "ls (sbx/host)",
		async execute(id, params, signal, onUpdate) {
			const activeTransport = selectedTransport();
			if (!activeTransport) return localLs.execute(id, params, signal, onUpdate);
			return createLsTool(cwd, { operations: createSbxLsOps(activeTransport, cwd) }).execute(
				id,
				params,
				signal,
				onUpdate,
			);
		},
	});
	pi.registerTool({
		...localFind,
		label: "find (sbx/host)",
		async execute(id, params, signal, onUpdate) {
			const activeTransport = selectedTransport();
			if (!activeTransport) return localFind.execute(id, params, signal, onUpdate);
			return createFindTool(cwd, { operations: createSbxFindOps(activeTransport, cwd) }).execute(
				id,
				params,
				signal,
				onUpdate,
			);
		},
	});
	pi.registerTool({
		...localGrep,
		label: "grep (sbx/host)",
		async execute(id, params, signal, onUpdate) {
			const activeTransport = selectedTransport();
			if (!activeTransport) return localGrep.execute(id, params, signal, onUpdate);
			return executeSbxGrep(activeTransport, cwd, params, signal);
		},
	});

	pi.on("tool_call", (event) => {
		if (!selectedSandbox() || ROUTED_TOOLS.has(event.toolName)) return;
		return {
			block: true,
			reason: `Tool ${event.toolName} is not sandbox-aware and cannot run in the selected sbx sandbox.`,
		};
	});

	pi.on("user_bash", () => {
		const activeTransport = selectedTransport();
		return activeTransport ? { operations: createSbxBashOps(activeTransport) } : undefined;
	});

	pi.on("before_agent_start", (event) => {
		const sandbox = selectedSandbox();
		const environment = sandbox
			? `Tool execution environment: sbx sandbox ${sandbox}. Pi itself runs on the host; tool processes and filesystem operations run in the sandbox.`
			: "Tool execution environment: host fallback. Sandboxing is disabled or no matching sbx sandbox is available, so Pi tools run directly on the host as they normally do.";
		return { systemPrompt: `${event.systemPrompt}\n\n${environment}` };
	});

	pi.on("session_shutdown", () => disposeTransport());

	pi.on("session_start", async (_event, ctx) => {
		const restored = restoredSelection(ctx);
		sandboxingEnabled = restored?.hostFallback !== true;
		try {
			await discover(ctx);
			if (sandboxingEnabled) {
				selectedName = sandboxes.find((sandbox) => sandbox.name === restored?.name)?.name ?? sandboxes[0]?.name;
			}
			updateStatus(ctx);
			if (!selectedSandbox()) {
				ctx.ui.notify(`No sbx sandbox is active for ${cwd}. Tool calls will run on the host.`, "warning");
			}
		} catch (error) {
			selectedName = undefined;
			updateStatus(ctx);
			ctx.ui.notify(`Could not discover sbx sandboxes; tool calls will run on the host: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	});

	pi.registerCommand("sbx", {
		description: "Select an sbx sandbox, or use /sbx off to run tools on the host",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const action = args.trim().toLowerCase();
			if (action === "off" || action === "host") {
				useHostFallback(ctx);
				ctx.ui.notify("Sandboxing disabled for this session; tool calls now run on the host.", "info");
				return;
			}
			if (action && action !== "on") {
				ctx.ui.notify("Usage: /sbx, /sbx on, or /sbx off", "warning");
				return;
			}
			try {
				await discover(ctx);
			} catch (error) {
				useHostFallback(ctx);
				ctx.ui.notify(`Could not discover sbx sandboxes; tool calls will run on the host: ${error instanceof Error ? error.message : String(error)}`, "warning");
				return;
			}
			if (sandboxes.length === 0) {
				ctx.ui.notify(`No sbx sandbox mounts ${cwd}; tool calls will run on the host.`, "warning");
				return;
			}
			if (action === "on" && selectedName && sandboxes.some((sandbox) => sandbox.name === selectedName)) {
				sandboxingEnabled = true;
				pi.appendEntry<SelectionState>(STATE_ENTRY, { name: selectedName });
				updateStatus(ctx);
				ctx.ui.notify(`Tool calls now execute in ${selectedName}.`, "info");
				return;
			}
			const hostLabel = "Host (disable sandboxing)";
			const labels = [
				hostLabel,
				...sandboxes.map((sandbox) => {
					const selected = sandboxingEnabled && sandbox.name === selectedName ? " • selected" : "";
					return `${sandbox.name} (${sandbox.status ?? "unknown"})${selected}`;
				}),
			];
			const choice = await ctx.ui.select("Tool execution environment", labels);
			if (!choice) return;
			if (choice === hostLabel) {
				useHostFallback(ctx);
				ctx.ui.notify("Sandboxing disabled for this session; tool calls now run on the host.", "info");
				return;
			}
			const index = labels.indexOf(choice) - 1;
			const nextName = sandboxes[index]?.name;
			if (!nextName) return;
			if (selectedName !== nextName) disposeTransport();
			selectedName = nextName;
			sandboxingEnabled = true;
			pi.appendEntry<SelectionState>(STATE_ENTRY, { name: selectedName });
			updateStatus(ctx);
			ctx.ui.notify(`Tool calls now execute in ${selectedName}.`, "info");
		},
	});
}
