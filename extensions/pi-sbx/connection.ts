import { setTimeout as delay } from "node:timers/promises";
import type { SbxSandbox } from "./discovery.ts";
import { SbxConnectionError, SbxTransport, waitForConnection } from "./transport.ts";

export interface SandboxList {
	executable: string;
	sandboxes: SbxSandbox[];
}

export type ConnectionPhase = "waiting" | "reconnecting" | "connecting" | "initializing" | "ready" | "failed" | "host" | "closed";
export interface ConnectionState {
	phase: ConnectionPhase;
	sandbox?: SbxSandbox;
	error?: string;
}

export interface ConnectionOptions {
	discover(signal: AbortSignal, timeoutMs: number): Promise<SandboxList>;
	createTransport(sandbox: SbxSandbox, executable: string, onInitializing: () => void, onFailure: (error: Error) => void): SbxTransport;
	onChange(state: ConnectionState): void;
	notify(message: string, type: "info" | "warning"): void;
	discoveryTimeoutMs?: number;
	pollIntervalMs?: number;
	toolWaitMs?: number;
}

const RECOVERY = "Run /sbx to check again, or /sbx off to run tools on the host.";

/** Session-scoped discovery and connection. Missing SBX never grants host access. */
export class SandboxConnection {
	state: ConnectionState = { phase: "waiting" };
	private controller = new AbortController();
	private transport: SbxTransport | undefined;
	private pending: Promise<void> | undefined;
	private readonly options: ConnectionOptions;

	constructor(options: ConnectionOptions) {
		this.options = options;
	}

	start(preferredName?: string, selection?: SandboxList): void {
		this.begin(preferredName, selection);
	}

	private begin(preferredName?: string, selection?: SandboxList, reconnecting?: SbxSandbox): void {
		this.cancel();
		const controller = this.controller;
		this.update(reconnecting ? { phase: "reconnecting", sandbox: reconnecting } : { phase: "waiting" });
		if (reconnecting) {
			this.options.notify(`Sandbox ${reconnecting.name} disconnected; reconnecting. Interrupted tools are not replayed and may have partially executed.`, "info");
		}
		// Neither session_start, a command, nor worker loss waits for this operation.
		this.pending = this.prepare(controller.signal, preferredName, selection, reconnecting).catch((error: unknown) => {
			if (controller.signal.aborted) return;
			this.fail(error instanceof Error ? error.message : String(error));
		});
	}

	host(): void {
		this.cancel();
		this.update({ phase: "host" });
	}

	close(): void {
		this.cancel();
		this.update({ phase: "closed" });
	}

	async list(signal: AbortSignal): Promise<SandboxList> {
		return this.options.discover(signal, 10_000);
	}

	async requireTransport(signal?: AbortSignal): Promise<SbxTransport | undefined> {
		if (signal?.aborted) throw new Error("aborted");
		if (this.state.phase === "host") return undefined;
		const controller = this.controller;
		if (this.pending && !["ready", "failed", "closed"].includes(this.state.phase)) {
			await waitForConnection(this.pending, signal, this.options.toolWaitMs ?? 2_000);
		}
		if (controller !== this.controller || controller.signal.aborted) {
			throw new Error("Tool execution environment changed; retry the call.");
		}
		if (this.state.phase === "ready" && this.transport) return this.transport;
		throw new Error(this.state.error ?? `Sandbox not ready (${this.state.phase}); this tool was not executed. ${RECOVERY}`);
	}

	private async prepare(signal: AbortSignal, preferredName?: string, selection?: SandboxList, reconnecting?: SbxSandbox): Promise<void> {
		const deadline = Date.now() + (this.options.discoveryTimeoutMs ?? 60_000);
		let notifiedWaiting = !!reconnecting;
		let lastError: unknown;
		const expired = () => new Error(reconnecting
			? `Could not reconnect to sandbox ${reconnecting.name} before the discovery deadline.${lastError instanceof Error ? ` ${lastError.message}` : ""}`
			: "No sandbox became available before the discovery deadline.");
		while (!signal.aborted) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw expired();
			let list: SandboxList | undefined;
			try {
				list = selection ?? await this.options.discover(signal, Math.min(10_000, remaining));
			} catch (error) {
				if (!reconnecting) throw error;
				lastError = error;
			}
			selection = undefined;
			if (signal.aborted) return;
			if (Date.now() >= deadline) throw expired();
			// Rediscover mounts and the instance, but never choose a different name.
			const sandbox = preferredName
				? list?.sandboxes.find((entry) => entry.name === preferredName)
				: list?.sandboxes[0];
			if (sandbox && list) {
				this.update({ phase: "connecting", sandbox });
				let failure: Error | undefined;
				const transport = this.options.createTransport(sandbox, list.executable,
					() => { if (!signal.aborted) this.update({ phase: "initializing", sandbox }); },
					(error) => {
						if (signal.aborted || this.transport !== transport) return;
						failure = error;
						if (this.state.phase !== "ready") return; // connect() handles startup failure.
						if (error instanceof SbxConnectionError) this.begin(sandbox.name, undefined, sandbox);
						else this.fail(error.message);
					});
				this.transport = transport;
				try {
					await transport.connect(signal);
					// Failure may follow the ready frame before connect() resumes.
					if (failure) throw failure;
					if (!signal.aborted) this.update({ phase: "ready", sandbox });
					return;
				} catch (error) {
					if (signal.aborted) return;
					transport.dispose();
					this.transport = undefined;
					// Removal/recreation can race discovery and sbx exec. Only retry
					// connection failures; image/protocol failures remain terminal.
					if (!reconnecting || !(error instanceof SbxConnectionError)) throw error;
					lastError = error;
				}
			}
			if (reconnecting) this.update({ phase: "reconnecting", sandbox: reconnecting });
			if (!notifiedWaiting) {
				notifiedWaiting = true;
				this.options.notify("Waiting for a sandbox for this workspace. You can keep chatting. Use /sbx off to run tools on the host.", "info");
			}
			await delay(Math.min(this.options.pollIntervalMs ?? 1_000, Math.max(0, deadline - Date.now())), undefined, { signal });
		}
	}

	private fail(message: string): void {
		if (this.state.phase === "failed") return;
		this.transport?.dispose();
		this.transport = undefined;
		const error = `${message} Sandbox tools remain unavailable. ${RECOVERY}`;
		this.update({ ...this.state, phase: "failed", error });
		this.options.notify(error, "warning");
	}

	private cancel(): void {
		this.controller.abort();
		this.transport?.dispose();
		this.transport = undefined;
		this.pending = undefined;
		this.controller = new AbortController();
	}

	private update(state: ConnectionState): void {
		this.state = state;
		this.options.onChange(state);
	}
}
