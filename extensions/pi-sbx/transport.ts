import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

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

export type SpawnWorker = (sandbox: string, cwd: string) => ChildProcessWithoutNullStreams;

export const SBX_WORKER_SCRIPT = String.raw`
const { spawn } = require("node:child_process");
const readline = require("node:readline");

const processes = new Map();
const cancelled = new Set();

function emit(message) {
    process.stdout.write(JSON.stringify(message) + "\n");
}

function emitBuffer(type, id, data) {
    emit({ type, id, data: data.toString("base64") });
}

function killProcess(child) {
    if (!child.pid) return;
    try {
        process.kill(-child.pid, "SIGKILL");
    } catch {
        try {
            child.kill("SIGKILL");
        } catch {
            // The process already exited.
        }
    }
}

function execute(request) {
    const id = request.id;
    if (cancelled.delete(id)) {
        emit({ type: "error", id, message: "aborted" });
        return;
    }

    let child;
    try {
        child = spawn(request.command[0], request.command.slice(1), {
            cwd: request.cwd,
            detached: true,
            stdio: [request.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        });
    } catch (error) {
        emit({ type: "error", id, message: error instanceof Error ? error.message : String(error) });
        return;
    }

    processes.set(id, child);
    if (cancelled.delete(id)) killProcess(child);

    let settled = false;
    const finish = (exitCode) => {
        if (settled) return;
        settled = true;
        processes.delete(id);
        cancelled.delete(id);
        emit({ type: "result", id, exitCode });
    };

    child.stdout.on("data", (data) => emitBuffer("stdout", id, data));
    child.stderr.on("data", (data) => emitBuffer("stderr", id, data));
    child.on("error", (error) => {
        emitBuffer("stderr", id, Buffer.from(error.message + "\n"));
        finish(error.code === "ENOENT" ? 127 : 126);
    });
    child.on("close", (exitCode) => finish(exitCode));

    if (child.stdin) {
        child.stdin.on("error", () => {});
        child.stdin.end(Buffer.from(request.input, "base64"));
    }
}

function cancel(id) {
    const child = processes.get(id);
    if (child) killProcess(child);
    else cancelled.add(id);
}

function shutdown() {
    for (const child of processes.values()) killProcess(child);
}

process.once("SIGTERM", shutdown);
process.once("SIGHUP", shutdown);
process.once("exit", shutdown);

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
    try {
        const request = JSON.parse(line);
        if (request.type === "exec") execute(request);
        else if (request.type === "cancel") cancel(request.id);
    } catch (error) {
        emit({ type: "error", id: "", message: error instanceof Error ? error.message : String(error) });
    }
});
input.on("close", shutdown);
emit({ type: "ready" });
`;

function spawnSbxWorker(sandbox: string, cwd: string): ChildProcessWithoutNullStreams {
	return spawn("sbx", ["exec", "-i", "--workdir", cwd, sandbox, "node", "-e", SBX_WORKER_SCRIPT], {
		detached: true,
		stdio: ["pipe", "pipe", "pipe"],
	});
}

function killProcess(child: ChildProcessWithoutNullStreams): void {
	if (!child.pid) return;
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export class SbxTransport {
	private readonly sandbox: string;
	private readonly workerCwd: string;
	private readonly spawnWorker: SpawnWorker;
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

	constructor(sandbox: string, workerCwd: string, spawnWorker: SpawnWorker = spawnSbxWorker) {
		this.sandbox = sandbox;
		this.workerCwd = workerCwd;
		this.spawnWorker = spawnWorker;
	}

	async execute(cwd: string, command: string[], options: SbxExecOptions = {}): Promise<SbxExecResult> {
		if (options.signal?.aborted) throw new Error("aborted");
		await this.start();
		if (options.signal?.aborted) throw new Error("aborted");
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
					cwd,
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
		this.stdoutPending = "";
		this.stderrPending = "";

		try {
			const child = this.spawnWorker(this.sandbox, this.workerCwd);
			this.child = child;
			this.startupTimer = setTimeout(() => {
				this.handleExit(child, new Error(`Timed out starting sbx transport for ${this.sandbox}`));
			}, DEFAULT_STARTUP_TIMEOUT_MS);
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
		if (message.type === "ready") {
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
		killProcess(child);
		this.child = undefined;
		this.failStart(error);
		this.startPromise = undefined;
		this.rejectPending(error);
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
