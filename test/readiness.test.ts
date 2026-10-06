import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SBX_WORKER_SCRIPT, SbxTransport, type SbxTransportOptions } from "../extensions/pi-sbx/transport.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

async function fixture(t: test.TestContext, helper?: string, options: SbxTransportOptions = {}, configured = true) {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-sbx-readiness-"));
	if (helper) await writeFile(path.join(directory, "sandbox-startup"), `#!/bin/sh\n${helper}\n`, { mode: 0o755 });
	const initializing = deferred();
	const transport = new SbxTransport("fixture", directory, {
		onInitializing: initializing.resolve,
		spawnWorker: () => spawn(process.execPath, ["-e", SBX_WORKER_SCRIPT], {
			cwd: directory, detached: true, stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, PATH: helper ? `${directory}:/usr/bin:/bin` : directory, SBX_STARTUP_DIR: configured ? directory : "" },
		}),
		...options,
	});
	t.after(async () => { transport.dispose(); await rm(directory, { recursive: true, force: true }); });
	return { directory, transport, initializing: initializing.promise };
}

test("unconfigured images are immediately usable without a helper", async (t) => {
	const f = await fixture(t, undefined, {}, false);
	await f.transport.connect();
	const result = await f.transport.execute(f.directory, [process.execPath, "-e", "console.log('ready')"]);
	assert.equal(result.stdout.toString(), "ready\n");
});

test("an installed helper is not invoked when SBX_STARTUP_DIR is empty", async (t) => {
	const f = await fixture(t, "touch invoked; exit 1", {}, false);
	await f.transport.connect();
	await assert.rejects(access(path.join(f.directory, "invoked")));
});

test("waits for the image contract, not the old transport deadline; no timed-out tool is replayed", async (t) => {
	const f = await fixture(t, 'printf "%s\\n" "$@" > arguments; while [ ! -e release ]; do sleep 0.01; done', {
		startupTimeoutMs: 1_000, initializationTimeoutMs: 5_000,
	});
	const connecting = f.transport.connect();
	await f.initializing;
	await assert.rejects(f.transport.execute(f.directory, ["touch", "never-executed"]), /not ready.*not executed/);
	assert.deepEqual((await readFile(path.join(f.directory, "arguments"), "utf8")).trim().split("\n"), ["wait", "--timeout", "60"]);
	await writeFile(path.join(f.directory, "release"), "");
	await connecting;
	await assert.rejects(access(path.join(f.directory, "never-executed")));
	const result = await f.transport.execute(f.directory, ["printf", "usable"]);
	assert.equal(result.stdout.toString(), "usable");
});

test("configured images with missing helpers fail closed", async (t) => {
	const f = await fixture(t);
	await assert.rejects(f.transport.connect(), /SBX_STARTUP_DIR is configured but sandbox-startup is unavailable/);
});

test("readiness failure suppresses private helper output", async (t) => {
	const f = await fixture(t, "echo private-secret; echo private-secret >&2; exit 7");
	await assert.rejects(f.transport.connect(), (error: Error) => {
		assert.match(error.message, /Startup initialization failed/);
		assert.doesNotMatch(error.message, /private-secret/);
		return true;
	});
});

test("hung initialization is bounded independently from connecting", async (t) => {
	const f = await fixture(t, "sleep 30", { initializationTimeoutMs: 50 });
	await assert.rejects(f.transport.connect(), /startup initialization timed out/);
});

test("disposal cancels an initializing worker and never reports ready", async (t) => {
	const f = await fixture(t, "sleep 30");
	const connecting = f.transport.connect();
	await f.initializing;
	f.transport.dispose();
	await assert.rejects(connecting, /was closed/);
	await assert.rejects(f.transport.execute(f.directory, ["touch", "never-executed"]), /was closed/);
	await assert.rejects(access(path.join(f.directory, "never-executed")));
});

test("a cancelled tool is never sent when shared initialization finishes later", async (t) => {
	const f = await fixture(t, 'while [ ! -e release ]; do sleep 0.01; done');
	const connecting = f.transport.connect();
	await f.initializing;
	const controller = new AbortController();
	const call = f.transport.execute(f.directory, ["touch", "never-executed"], { signal: controller.signal });
	controller.abort();
	await assert.rejects(call, /aborted/);
	await writeFile(path.join(f.directory, "release"), "");
	await connecting;
	await assert.rejects(access(path.join(f.directory, "never-executed")));
});

test("worker rejects early protocol requests rather than queuing them", async (t) => {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-sbx-early-request-"));
	await writeFile(path.join(directory, "sandbox-startup"), "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
	const child = spawn(process.execPath, ["-e", SBX_WORKER_SCRIPT], {
		cwd: directory, detached: true, stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, PATH: `${directory}:/usr/bin:/bin`, SBX_STARTUP_DIR: directory },
	});
	t.after(async () => {
		try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already stopped */ }
		await rm(directory, { recursive: true, force: true });
	});
	const rejected = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("worker did not reject early request")), 2_000);
		let output = "";
		child.stdout.on("data", (data) => {
			output += data.toString();
			if (output.includes('"type":"error","id":"early"')) { clearTimeout(timer); resolve(); }
		});
	});
	child.stdin.write(`${JSON.stringify({ type: "exec", id: "early", cwd: directory, command: ["touch", "never-executed"] })}\n`);
	await rejected;
	await assert.rejects(access(path.join(directory, "never-executed")));
});
