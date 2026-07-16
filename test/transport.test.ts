import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { SBX_WORKER_SCRIPT, SbxTransport, type SpawnWorker } from "../extensions/pi-sbx/transport.ts";

const spawnLocalWorker: SpawnWorker = () =>
	spawn("python3", ["-u", "-c", SBX_WORKER_SCRIPT], {
		detached: true,
		stdio: ["pipe", "pipe", "pipe"],
	});

function localTransport(): SbxTransport {
	return new SbxTransport("test", process.cwd(), spawnLocalWorker);
}

test("reuses one worker for concurrent commands and keeps output separated", async (t) => {
	const transport = localTransport();
	t.after(() => transport.dispose());

	const results = await Promise.all(
		Array.from({ length: 20 }, (_, index) =>
			transport.execute(process.cwd(), [
				"sh",
				"-c",
				`printf 'stdout-${index}'; printf 'stderr-${index}' >&2`,
			]),
		),
	);

	for (const [index, result] of results.entries()) {
		assert.equal(result.exitCode, 0);
		assert.equal(result.stdout.toString(), `stdout-${index}`);
		assert.equal(result.stderr.toString(), `stderr-${index}`);
	}
});

test("forwards binary stdin and streams output", async (t) => {
	const transport = localTransport();
	t.after(() => transport.dispose());
	const input = Buffer.from("hello\0world");
	const streamed: Buffer[] = [];

	const result = await transport.execute(process.cwd(), ["cat"], {
		input,
		onStdout: (data) => streamed.push(data),
	});

	assert.equal(result.exitCode, 0);
	assert.deepEqual(result.stdout, input);
	assert.deepEqual(Buffer.concat(streamed), input);
});

test("reports a missing executable as a command failure", async (t) => {
	const transport = localTransport();
	t.after(() => transport.dispose());

	const result = await transport.execute(process.cwd(), ["pi-sbx-command-that-does-not-exist"]);
	assert.equal(result.exitCode, 127);
	assert.match(result.stderr.toString(), /No such file or directory/);
});

test("streams output before a command exits", async (t) => {
	const transport = localTransport();
	t.after(() => transport.dispose());
	let finished = false;
	let resolveFirstChunk: (() => void) | undefined;
	const firstChunk = new Promise<void>((resolve) => {
		resolveFirstChunk = resolve;
	});

	const execution = transport
		.execute(process.cwd(), ["sh", "-c", "printf first; sleep 0.1; printf second"], {
			onStdout: () => resolveFirstChunk?.(),
		})
		.finally(() => {
			finished = true;
		});

	await firstChunk;
	assert.equal(finished, false);
	const result = await execution;
	assert.equal(result.stdout.toString(), "firstsecond");
});

test("cancels timed-out commands without killing the worker", async (t) => {
	const transport = localTransport();
	t.after(() => transport.dispose());

	await assert.rejects(
		transport.execute(process.cwd(), ["sleep", "10"], { timeoutSeconds: 0.05 }),
		/timeout:0\.05/,
	);

	const result = await transport.execute(process.cwd(), ["printf", "still-alive"]);
	assert.equal(result.stdout.toString(), "still-alive");
});
