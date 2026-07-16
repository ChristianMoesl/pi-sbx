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
import base64
import json
import os
import signal
import subprocess
import sys
import threading

output_lock = threading.Lock()
process_lock = threading.Lock()
processes = {}
cancelled = set()


def emit(message):
    encoded = json.dumps(message, separators=(",", ":"))
    with output_lock:
        sys.stdout.write(encoded + "\n")
        sys.stdout.flush()


def emit_bytes(event_type, request_id, data):
    emit({"type": event_type, "id": request_id, "data": base64.b64encode(data).decode("ascii")})


def pump(stream, event_type, request_id):
    while True:
        chunk = os.read(stream.fileno(), 65536)
        if not chunk:
            return
        emit_bytes(event_type, request_id, chunk)


def kill_process(process):
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except Exception:
        try:
            process.kill()
        except Exception:
            pass


def execute(request):
    request_id = request["id"]
    process = None
    try:
        with process_lock:
            if request_id in cancelled:
                cancelled.discard(request_id)
                emit({"type": "error", "id": request_id, "message": "aborted"})
                return

        input_value = request.get("input")
        process = subprocess.Popen(
            request["command"],
            cwd=request["cwd"],
            stdin=subprocess.PIPE if input_value is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        with process_lock:
            processes[request_id] = process
            should_cancel = request_id in cancelled
            cancelled.discard(request_id)
        if should_cancel:
            kill_process(process)

        stdout_thread = threading.Thread(target=pump, args=(process.stdout, "stdout", request_id), daemon=True)
        stderr_thread = threading.Thread(target=pump, args=(process.stderr, "stderr", request_id), daemon=True)
        stdout_thread.start()
        stderr_thread.start()

        if input_value is not None and process.stdin is not None:
            try:
                process.stdin.write(base64.b64decode(input_value))
            except BrokenPipeError:
                pass
            finally:
                process.stdin.close()

        exit_code = process.wait()
        stdout_thread.join()
        stderr_thread.join()
        emit({"type": "result", "id": request_id, "exitCode": exit_code})
    except FileNotFoundError as error:
        emit_bytes("stderr", request_id, (str(error) + "\n").encode())
        emit({"type": "result", "id": request_id, "exitCode": 127})
    except PermissionError as error:
        emit_bytes("stderr", request_id, (str(error) + "\n").encode())
        emit({"type": "result", "id": request_id, "exitCode": 126})
    except Exception as error:
        emit({"type": "error", "id": request_id, "message": str(error)})
    finally:
        with process_lock:
            processes.pop(request_id, None)
            cancelled.discard(request_id)


def cancel(request_id):
    with process_lock:
        cancelled.add(request_id)
        process = processes.get(request_id)
    if process is not None:
        kill_process(process)


emit({"type": "ready"})
for line in sys.stdin:
    try:
        request = json.loads(line)
        if request.get("type") == "exec":
            threading.Thread(target=execute, args=(request,), daemon=True).start()
        elif request.get("type") == "cancel":
            cancel(request["id"])
    except Exception as error:
        emit({"type": "error", "id": "", "message": str(error)})

with process_lock:
    remaining_processes = list(processes.values())
for process in remaining_processes:
    kill_process(process)
`;

function spawnSbxWorker(sandbox: string, cwd: string): ChildProcessWithoutNullStreams {
	return spawn("sbx", ["exec", "-i", "--workdir", cwd, sandbox, "python3", "-u", "-c", SBX_WORKER_SCRIPT], {
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
