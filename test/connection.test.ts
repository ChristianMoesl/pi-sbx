import assert from "node:assert/strict";
import test from "node:test";
import { SandboxConnection, type ConnectionOptions, type ConnectionState, type SandboxList } from "../extensions/pi-sbx/connection.ts";
import type { SbxTransport } from "../extensions/pi-sbx/transport.ts";

const sandbox = { name: "example", id: "instance-1", workspaces: ["/work"], mounts: [] };
const list: SandboxList = { executable: "sbx", sandboxes: [sandbox] };

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

async function until(condition: () => boolean): Promise<void> {
	for (let attempt = 0; !condition() && attempt < 500; attempt++) await new Promise((resolve) => setTimeout(resolve, 2));
	assert.ok(condition(), "condition reached");
}

function fixture(t: test.TestContext, overrides: Partial<ConnectionOptions> = {}) {
	const notifications: string[] = [];
	const notificationTypes: Array<"info" | "warning"> = [];
	const states: ConnectionState[] = [];
	let disposed = 0;
	let workerFailure!: (error: Error) => void;
	const transport = { connect: async () => {}, dispose: () => { disposed++; } } as unknown as SbxTransport;
	const connection = new SandboxConnection({
		discover: async () => list,
		createTransport: (_sandbox, _executable, _initializing, failure) => { workerFailure = failure; return transport; },
		onChange: (state) => states.push(state),
		notify: (message, type) => { notifications.push(message); notificationTypes.push(type); },
		pollIntervalMs: 5, discoveryTimeoutMs: 200, toolWaitMs: 5,
		...overrides,
	});
	t.after(() => connection.close());
	return { connection, transport, notifications, notificationTypes, states, disposed: () => disposed, fail: (error: Error) => workerFailure(error) };
}

test("connects eagerly without awaiting startup or notifying on success", async (t) => {
	const f = fixture(t);
	assert.equal(f.connection.start(), undefined);
	await until(() => f.connection.state.phase === "ready");
	assert.equal(await f.connection.requireTransport(), f.transport);
	assert.deepEqual(f.notifications, []);
	assert.deepEqual(f.states.map((state) => state.phase), ["waiting", "connecting", "ready"]);
});

test("polls non-overlapping discoveries and notifies only once as info before late success", async (t) => {
	let calls = 0;
	let active = 0;
	const f = fixture(t, { discover: async () => {
		assert.equal(++active, 1);
		await new Promise((resolve) => setTimeout(resolve, 2));
		active--;
		return ++calls < 3 ? { ...list, sandboxes: [] } : list;
	} });
	f.connection.start();
	await until(() => f.connection.state.phase === "ready");
	assert.equal(calls, 3);
	assert.equal(f.notifications.length, 1);
	assert.match(f.notifications[0]!, /Waiting for a sandbox.*\/sbx off/);
	assert.deepEqual(f.notificationTypes, ["info"]);
});

test("discovery expiry remains fail-closed, with one terminal notification", async (t) => {
	const f = fixture(t, { discover: async () => ({ ...list, sandboxes: [] }), discoveryTimeoutMs: 30 });
	f.connection.start();
	await until(() => f.connection.state.phase === "failed");
	assert.equal(f.notifications.length, 2);
	assert.deepEqual(f.notificationTypes, ["info", "warning"]);
	assert.match(f.notifications[1]!, /discovery deadline.*tools remain unavailable.*\/sbx off/);
	await assert.rejects(f.connection.requireTransport(), /discovery deadline/);
});

test("discovery errors never enable host execution", async (t) => {
	const f = fixture(t, { discover: async () => { throw new Error("daemon unavailable"); } });
	f.connection.start();
	await until(() => f.connection.state.phase === "failed");
	assert.match(f.notifications[0]!, /daemon unavailable/);
	assert.deepEqual(f.notificationTypes, ["warning"]);
	await assert.rejects(f.connection.requireTransport(), /daemon unavailable/);
});

test("short per-tool wait does not stop readiness or replay a call", async (t) => {
	const startup = deferred();
	let connects = 0;
	const transport = { connect: () => { connects++; return startup.promise; }, dispose() {} } as unknown as SbxTransport;
	const f = fixture(t, { createTransport: (_sandbox, _executable, initializing) => { initializing(); return transport; } });
	f.connection.start();
	await until(() => f.connection.state.phase === "initializing");
	await assert.rejects(f.connection.requireTransport(), /Sandbox not ready/);
	assert.equal(connects, 1);
	startup.resolve();
	await until(() => f.connection.state.phase === "ready");
	assert.equal(await f.connection.requireTransport(), transport);
	assert.deepEqual(f.notifications, []);
});

test("abort ends a tool's wait without cancelling shared preparation", async (t) => {
	const startup = deferred();
	const transport = { connect: () => startup.promise, dispose() {} } as unknown as SbxTransport;
	const f = fixture(t, { createTransport: () => transport, toolWaitMs: 1_000 });
	f.connection.start();
	await until(() => f.connection.state.phase === "connecting");
	const controller = new AbortController();
	const call = f.connection.requireTransport(controller.signal);
	controller.abort();
	await assert.rejects(call, /aborted/);
	startup.resolve();
	await until(() => f.connection.state.phase === "ready");
});

test("host mode wins over delayed discovery, and shutdown aborts discovery", async (t) => {
	const discovery = deferred();
	let signal!: AbortSignal;
	const f = fixture(t, { discover: async (abort) => { signal = abort; await discovery.promise; return list; } });
	f.connection.start();
	f.connection.host();
	assert.ok(signal.aborted);
	discovery.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(f.connection.state.phase, "host");
	assert.equal(await f.connection.requireTransport(), undefined);
	assert.deepEqual(f.notifications, []);
	f.connection.start();
	f.connection.close();
	assert.ok(signal.aborted);
	await assert.rejects(f.connection.requireTransport(), /closed/);
});

test("a late worker cannot re-enable sandboxing after manual off", async (t) => {
	const startup = deferred();
	let initializing!: () => void;
	let disposed = 0;
	const transport = { connect: () => startup.promise, dispose: () => { disposed++; } } as unknown as SbxTransport;
	const f = fixture(t, { createTransport: (_sandbox, _executable, callback) => { initializing = callback; return transport; } });
	f.connection.start();
	await until(() => f.connection.state.phase === "connecting");
	const waitingCall = f.connection.requireTransport();
	f.connection.host();
	initializing();
	startup.resolve();
	await assert.rejects(waitingCall, /environment changed/);
	assert.equal(f.connection.state.phase, "host");
	assert.equal(disposed, 1);
	assert.deepEqual(f.notifications, []);
});

test("saved selections are not silently replaced by another matching sandbox", async (t) => {
	let calls = 0;
	const f = fixture(t, { discover: async () => {
		calls++;
		return calls === 1 ? list : { ...list, sandboxes: [{ ...sandbox, name: "saved" }] };
	} });
	f.connection.start("saved");
	await until(() => f.connection.state.phase === "ready");
	assert.equal(f.connection.state.sandbox?.name, "saved");
	assert.equal(f.notifications.length, 1);
});

test("retry creates one new connection and late failure from the old attempt is ignored", async (t) => {
	const f = fixture(t);
	f.connection.start();
	await until(() => f.connection.state.phase === "ready");
	f.fail(new Error("worker lost"));
	assert.equal(f.connection.state.phase, "failed");
	await assert.rejects(f.connection.requireTransport(), /worker lost/);
	f.connection.start();
	f.fail(new Error("old worker close event"));
	await until(() => f.connection.state.phase === "ready");
	assert.equal(f.disposed(), 1);
	assert.equal(f.notifications.length, 1);
});

test("startup rejection is notified once and never converted to host execution", async (t) => {
	const f = fixture(t, { createTransport: (_sandbox, _executable, _initializing, failure) => ({
		connect: async () => { const error = new Error("initialization failed"); failure(error); throw error; },
		dispose() {},
	}) as unknown as SbxTransport });
	f.connection.start();
	await until(() => f.connection.state.phase === "failed");
	await assert.rejects(f.connection.requireTransport(), /initialization failed/);
	assert.equal(f.notifications.length, 1);
	assert.deepEqual(f.notificationTypes, ["warning"]);
});

test("a failure after the ready frame cannot be overwritten when connect resumes", async (t) => {
	const f = fixture(t, { createTransport: (_sandbox, _executable, _initializing, failure) => ({
		connect: async () => { failure(new Error("worker protocol failed after ready")); },
		dispose() {},
	}) as unknown as SbxTransport });
	f.connection.start();
	await until(() => f.connection.state.phase === "failed");
	await new Promise((resolve) => setTimeout(resolve, 0));
	await assert.rejects(f.connection.requireTransport(), /protocol failed/);
	assert.ok(!f.states.some((state) => state.phase === "ready"));
	assert.equal(f.notifications.length, 1);
});
