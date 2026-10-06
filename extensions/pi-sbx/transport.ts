import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { WorkspacePaths } from "./paths.ts";

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 60;
const KILL_GRACE_MS = 1_000;

export interface SbxExecResult {
	stdout: Buffer;
	stderr: Buffer;
	exitCode: number | null;
}

export interface SbxExecOptions {
	input?: Buffer | string;
	onStdout?: (data: Buffer) => void;
	onStderr?: (data: Buffer) => void;
	signal?: AbortSignal;
	timeoutSeconds?: number;
}

interface WorkerExecRequest {
	type: "exec";
	id: string;
	cwd: string;
	command: string[];
	input?: string;
}

interface WorkerCancelRequest {
	type: "cancel";
	id: string;
}

type WorkerRequest = WorkerExecRequest | WorkerCancelRequest;

type WorkerMessage =
	| { type: "initializing" }
	| { type: "startup_error"; message: string }
	| { type: "ready" }
	| { type: "stdout" | "stderr"; id: string; data: string }
	| { type: "result"; id: string; exitCode: number | null }
	| { type: "error"; id: string; message: string };

interface PendingExecution {
	stdout: Buffer[];
	stderr: Buffer[];
	onStdout?: (data: Buffer) => void;
	onStderr?: (data: Buffer) => void;
	resolve: (result: SbxExecResult) => void;
	reject: (error: Error) => void;
	cleanup: () => void;
}

export type SpawnWorker = (sandbox: string, cwd: string, executable: string) => ChildProcessWithoutNullStreams;

export interface SbxTransportOptions {
	executable?: string;
	paths?: WorkspacePaths;
	spawnWorker?: SpawnWorker;
	onInitializing?: () => void;
	onFailure?: (error: Error) => void;
	startupTimeoutMs?: number;
	initializationTimeoutMs?: number;
}

export const SBX_WORKER_SCRIPT = readFileSync(new URL("./worker.cjs", import.meta.url), "utf8");

function spawnSbxWorker(sandbox: string, cwd: string, executable: string): ChildProcessWithoutNullStreams {
	return spawn(executable, ["exec", "-i", "--workdir", cwd, sandbox, "node", "-e", SBX_WORKER_SCRIPT], {
		// A Windows process holds its host cwd open. Don't lock the project directory
		// for the lifetime of sbx.exe; --workdir sets the independent sandbox cwd.
		cwd: tmpdir(),
		detached: process.platform !== "win32",
		windowsHide: true,
		stdio: ["pipe", "pipe", "pipe"],
	});
}

function killProcess(child: ChildProcessWithoutNullStreams): void {
	if (!child.pid) return;
	try {
		if (process.platform === "win32") child.kill("SIGKILL");
		else process.kill(-child.pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

/** Wait briefly without cancelling shared preparation or queuing a tool request. */
export function waitForConnection(promise: Promise<void>, signal?: AbortSignal, timeoutMs?: number): Promise<void> {
	if (signal?.aborted) return Promise.reject(new Error("aborted"));
	return new Promise((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const finish = (error?: unknown) => {
			cleanup();
			if (error) reject(error);
			else resolve();
		};
		const onAbort = () => finish(new Error("aborted"));
		signal?.addEventListener("abort", onAbort, { once: true });
		if (timeoutMs !== undefined) timer = setTimeout(() => finish(), timeoutMs);
		promise.then(() => finish(), finish);
	});
}

export class SbxTransport {
	private readonly sandbox: string;
	private readonly workerCwd: string;
	private readonly spawnWorker: SpawnWorker;
	private readonly executable: string;
	private readonly paths: WorkspacePaths;
	private child: ChildProcessWithoutNullStreams | undefined;
	private startPromise: Promise<void> | undefined;
	private resolveStart: (() => void) | undefined;
	private rejectStart: ((error: Error) => void) | undefined;
	private startupTimer: ReturnType<typeof setTimeout> | undefined;
	private stdoutPending = "";
	private stderrPending = "";
	private nextId = 1;
	private readonly pending = new Map<string, PendingExecution>();
	private disposed = false;
	private ready = false;
	private readonly options: SbxTransportOptions;

	constructor(sandbox: string, workerCwd: string, options: SbxTransportOptions = {}) {
		this.options = options;
		this.sandbox = sandbox;
		this.paths = options.paths ?? new WorkspacePaths();
		this.workerCwd = this.toSandboxPath(workerCwd);
		this.executable = options.executable ?? "sbx";
		this.spawnWorker = options.spawnWorker ?? spawnSbxWorker;
	}

	toSandboxPath(value: string): string {
		return this.paths.toSandbox(value);
	}

	connect(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.reject(new Error("aborted"));
		return waitForConnection(this.start(), signal);
	}

	async execute(cwd: string, command: string[], options: SbxExecOptions = {}): Promise<SbxExecResult> {
		if (options.signal?.aborted) throw new Error("aborted");
		await waitForConnection(this.start(), options.signal, 2_000);
		if (options.signal?.aborted) throw new Error("aborted");
		if (!this.ready) throw new Error("Sandbox worker not ready; this tool was not executed. Try again when initialization finishes.");
		if (!this.child) throw new Error(`sbx transport for ${this.sandbox} is not available`);

		const id = String(this.nextId++);
		return new Promise<SbxExecResult>((resolve, reject) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;

			const settleWithError = (error: Error) => {
				if (settled) return;
				settled = true;
				try {
					this.send({ type: "cancel", id });
				} catch {
					// The worker may already be gone.
				}
				this.pending.delete(id);
				cleanup();
				reject(error);
			};
			const onAbort = () => settleWithError(new Error("aborted"));
			const cleanup = () => {
				if (timer) clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
			};

			const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS;
			if (timeoutSeconds > 0) {
				timer = setTimeout(() => settleWithError(new Error(`timeout:${timeoutSeconds}`)), timeoutSeconds * 1000);
			}
			options.signal?.addEventListener("abort", onAbort, { once: true });

			this.pending.set(id, {
				stdout: [],
				stderr: [],
				onStdout: options.onStdout,
				onStderr: options.onStderr,
				resolve: (result) => {
					if (settled) return;
					settled = true;
					cleanup();
					resolve(result);
				},
				reject: settleWithError,
				cleanup,
			});

			try {
				this.send({
					type: "exec",
					id,
					cwd: this.toSandboxPath(cwd),
					command,
					input: options.input === undefined ? undefined : Buffer.from(options.input).toString("base64"),
				});
			} catch (error) {
				settleWithError(asError(error));
			}
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.ready = false;
		const error = new Error(`sbx transport for ${this.sandbox} was closed`);
		this.failStart(error);
		this.rejectPending(error);
		if (this.child) {
			this.child.stdin.end();
			const child = this.child;
			setTimeout(() => killProcess(child), KILL_GRACE_MS).unref();
		}
		this.child = undefined;
	}

	private start(): Promise<void> {
		if (this.disposed) return Promise.reject(new Error(`sbx transport for ${this.sandbox} was closed`));
		if (this.startPromise) return this.startPromise;

		const startPromise = new Promise<void>((resolve, reject) => {
			this.resolveStart = resolve;
			this.rejectStart = reject;
		});
		this.startPromise = startPromise;
		this.ready = false;
		this.stdoutPending = "";
		this.stderrPending = "";

		try {
			const child = this.spawnWorker(this.sandbox, this.workerCwd, this.executable);
			this.child = child;
			this.startupTimer = setTimeout(() => {
				this.handleExit(child, new Error(`Timed out starting sbx transport for ${this.sandbox}`));
			}, this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
			child.stdout.on("data", (data: Buffer) => this.handleStdout(data));
			child.stderr.on("data", (data: Buffer) => {
				this.stderrPending += data.toString();
			});
			child.on("error", (error) => this.handleExit(child, asError(error)));
			child.on("close", (exitCode) => {
				const detail = this.filteredTransportStderr();
				const suffix = detail ? `: ${detail}` : "";
				this.handleExit(child, new Error(`sbx transport for ${this.sandbox} exited with code ${exitCode}${suffix}`));
			});
		} catch (error) {
			this.child = undefined;
			this.failStart(asError(error));
			this.startPromise = undefined;
		}

		return startPromise;
	}

	private send(request: WorkerRequest): void {
		if (!this.child?.stdin.writable) throw new Error(`sbx transport for ${this.sandbox} is not writable`);
		this.child.stdin.write(`${JSON.stringify(request)}\n`);
	}

	private handleStdout(data: Buffer): void {
		this.stdoutPending += data.toString();
		const lines = this.stdoutPending.split("\n");
		this.stdoutPending = lines.pop() ?? "";
		for (const line of lines) {
			if (!line) continue;
			let message: WorkerMessage;
			try {
				message = JSON.parse(line) as WorkerMessage;
			} catch {
				const child = this.child;
				if (child) this.handleExit(child, new Error(`Invalid response from sbx transport for ${this.sandbox}`));
				return;
			}
			this.handleMessage(message);
		}
	}

	private handleMessage(message: WorkerMessage): void {
		if (message.type === "initializing") {
			if (this.startupTimer) clearTimeout(this.startupTimer);
			this.startupTimer = setTimeout(() => {
				if (this.child) this.handleExit(this.child, new Error(`Sandbox ${this.sandbox} startup initialization timed out`));
			}, this.options.initializationTimeoutMs ?? 65_000);
			this.options.onInitializing?.();
			return;
		}
		if (message.type === "startup_error") {
			if (this.child) this.handleExit(this.child, new Error(`Sandbox ${this.sandbox}: ${message.message}`));
			return;
		}
		if (message.type === "ready") {
			this.ready = true;
			if (this.startupTimer) clearTimeout(this.startupTimer);
			this.startupTimer = undefined;
			this.resolveStart?.();
			this.resolveStart = undefined;
			this.rejectStart = undefined;
			return;
		}

		const pending = this.pending.get(message.id);
		if (!pending) return;
		if (message.type === "stdout" || message.type === "stderr") {
			const data = Buffer.from(message.data, "base64");
			if (message.type === "stdout") {
				pending.stdout.push(data);
				pending.onStdout?.(data);
			} else {
				pending.stderr.push(data);
				pending.onStderr?.(data);
			}
			return;
		}

		this.pending.delete(message.id);
		if (message.type === "error") {
			pending.reject(new Error(message.message));
			return;
		}
		if (message.type !== "result") return;
		pending.cleanup();
		pending.resolve({
			stdout: Buffer.concat(pending.stdout),
			stderr: Buffer.concat(pending.stderr),
			exitCode: message.exitCode,
		});
	}

	private handleExit(child: ChildProcessWithoutNullStreams, error: Error): void {
		if (this.child !== child) return;
		this.ready = false;
		killProcess(child);
		this.child = undefined;
		this.failStart(error);
		this.startPromise = undefined;
		this.rejectPending(error);
		this.options.onFailure?.(error);
	}

	private failStart(error: Error): void {
		if (this.startupTimer) clearTimeout(this.startupTimer);
		this.startupTimer = undefined;
		this.rejectStart?.(error);
		this.resolveStart = undefined;
		this.rejectStart = undefined;
	}

	private rejectPending(error: Error): void {
		for (const pending of this.pending.values()) {
			pending.cleanup();
			pending.reject(error);
		}
		this.pending.clear();
	}

	private filteredTransportStderr(): string {
		return this.stderrPending
			.split("\n")
			.filter((line) => line.trim() && line.trim() !== `Sandbox ${this.sandbox} started successfully`)
			.join("\n")
			.trim();
	}
}
