"use strict";

const { spawn } = require("node:child_process");
const readline = require("node:readline");

const processes = new Map();
const cancelled = new Set();

function emit(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
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
		emitBuffer("stderr", id, Buffer.from(`${error.message}\n`));
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
