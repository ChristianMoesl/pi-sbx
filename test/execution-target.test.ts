import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piSbxExtension, {
	hostApprovalMessage,
	withoutExecutionTarget,
} from "../extensions/pi-sbx/index.ts";

const ROUTED_TOOLS = ["bash", "edit", "find", "grep", "ls", "read", "write"] as const;

type Handler = (event: any, ctx: ExtensionContext) => any;
type RegisteredTool = {
	parameters: { required?: string[]; properties: Record<string, any> };
	execute: (...args: any[]) => Promise<any>;
};

interface Harness {
	tools: Map<string, RegisteredTool>;
	handlers: Map<string, Handler[]>;
	context: ExtensionContext;
	confirmations: Array<{ title: string; message: string }>;
	setApproval(approved: boolean): void;
	emit(eventName: string, event: any): Promise<any[]>;
}

function createHarness(options: { sandbox?: boolean; hasUI?: boolean; activeTools?: string[] } = {}): Harness {
	const tools = new Map<string, RegisteredTool>();
	const handlers = new Map<string, Handler[]>();
	const confirmations: Array<{ title: string; message: string }> = [];
	let approved = true;
	const sandbox = options.sandbox ?? true;

	const context = {
		hasUI: options.hasUI ?? true,
		mode: options.hasUI === false ? "print" : "tui",
		cwd: process.cwd(),
		sessionManager: { getBranch: () => [] },
		ui: {
			theme: {
				fg: (_color: string, text: string) => text,
			},
			setStatus: () => {},
			notify: () => {},
			select: async () => undefined,
			confirm: async (title: string, message: string) => {
				confirmations.push({ title, message });
				return approved;
			},
		},
	} as unknown as ExtensionContext;

	const pi = {
		registerTool(tool: RegisteredTool) {
			tools.set((tool as RegisteredTool & { name: string }).name, tool);
		},
		registerCommand() {},
		on(eventName: string, handler: Handler) {
			const registered = handlers.get(eventName) ?? [];
			registered.push(handler);
			handlers.set(eventName, registered);
		},
		appendEntry() {},
		getActiveTools: () => options.activeTools ?? [...ROUTED_TOOLS],
		exec: async () => ({
			code: 0,
			stdout: JSON.stringify({
				sandboxes: sandbox
					? [{ name: "test-sandbox", status: "running", workspaces: [process.cwd()] }]
					: [],
			}),
			stderr: "",
		}),
	} as unknown as ExtensionAPI;

	piSbxExtension(pi);

	return {
		tools,
		handlers,
		context,
		confirmations,
		setApproval(value) {
			approved = value;
		},
		async emit(eventName, event) {
			const results = [];
			for (const handler of handlers.get(eventName) ?? []) results.push(await handler(event, context));
			return results;
		},
	};
}

async function startHarness(harness: Harness): Promise<void> {
	await harness.emit("session_start", { reason: "startup" });
}

function toolCall(toolName: string, toolCallId: string, input: Record<string, unknown>) {
	return { toolName, toolCallId, input };
}

test("adds the optional execution_target enum to every routed tool", () => {
	const harness = createHarness();

	for (const name of ROUTED_TOOLS) {
		const schema = harness.tools.get(name)?.parameters;
		assert.ok(schema, `${name} is registered`);
		assert.deepEqual(schema.properties.execution_target.enum, ["sandbox", "host"]);
		assert.equal(schema.properties.execution_target.type, "string");
		assert.ok(!schema.required?.includes("execution_target"));
	}
});

test("removes execution_target before delegating to a built-in tool", () => {
	assert.deepEqual(withoutExecutionTarget({ path: "README.md", execution_target: "host" }), {
		path: "README.md",
	});
});

test("approval message shows the tool, cwd, and exact arguments without the routing parameter", () => {
	const message = hostApprovalMessage(
		"bash",
		{ command: "git status", timeout: 10, execution_target: "host" },
		"/work/repo",
	);

	assert.match(message, /Tool: bash/);
	assert.match(message, /Working directory: \/work\/repo/);
	assert.match(message, /"command": "git status"/);
	assert.match(message, /"timeout": 10/);
	assert.doesNotMatch(message, /execution_target/);
	assert.match(message, /outside the selected sbx sandbox/);
});

test("approves one exact host call and executes it on the host", async () => {
	const harness = createHarness();
	await startHarness(harness);
	const input = { path: "README.md", limit: 1, execution_target: "host" as const };

	const [gateResult] = await harness.emit("tool_call", toolCall("read", "approved-read", input));
	assert.equal(gateResult, undefined);
	assert.equal(harness.confirmations.length, 1);
	assert.equal(harness.confirmations[0]?.title, "Allow host execution?");

	const result = await harness.tools.get("read")?.execute(
		"approved-read",
		input,
		undefined,
		undefined,
		harness.context,
	);
	assert.match(result.content[0].text, /pi-sbx/);
});

test("routes every approved built-in tool to the host", async (t) => {
	const harness = createHarness();
	await startHarness(harness);
	const tempDirectory = await mkdtemp(path.join(tmpdir(), "pi-sbx-host-tools-"));
	t.after(() => rm(tempDirectory, { recursive: true, force: true }));
	const filePath = path.join(tempDirectory, "example.txt");

	const calls: Array<{ name: string; input: Record<string, unknown> }> = [
		{ name: "bash", input: { command: "printf pi-sbx-host-bash" } },
		{ name: "write", input: { path: filePath, content: "alpha\n" } },
		{ name: "edit", input: { path: filePath, edits: [{ oldText: "alpha", newText: "beta" }] } },
		{ name: "read", input: { path: filePath } },
		{ name: "grep", input: { pattern: "beta", path: filePath } },
		{ name: "find", input: { pattern: "*.txt", path: tempDirectory } },
		{ name: "ls", input: { path: tempDirectory } },
	];

	for (const [index, call] of calls.entries()) {
		const id = `host-${call.name}-${index}`;
		const input = { ...call.input, execution_target: "host" };
		const [gateResult] = await harness.emit("tool_call", toolCall(call.name, id, input));
		assert.equal(gateResult, undefined);
		const tool = harness.tools.get(call.name);
		assert.ok(tool);
		await tool.execute(id, input, undefined, undefined, harness.context);
	}

	assert.equal(await readFile(filePath, "utf8"), "beta\n");
	assert.equal(harness.confirmations.length, calls.length);
});

test("does not prompt for normal sandbox calls and allows extension tools on the host", async () => {
	const harness = createHarness();
	await startHarness(harness);

	const [defaultResult] = await harness.emit("tool_call", toolCall("read", "sandbox-default", { path: "README.md" }));
	const [explicitResult] = await harness.emit(
		"tool_call",
		toolCall("read", "sandbox-explicit", { path: "README.md", execution_target: "sandbox" }),
	);
	const [extensionResult] = await harness.emit("tool_call", toolCall("third_party", "extension", {}));

	assert.equal(defaultResult, undefined);
	assert.equal(explicitResult, undefined);
	assert.equal(extensionResult, undefined);
	assert.equal(harness.confirmations.length, 0);
});

test("blocks host execution when the user denies approval", async () => {
	const harness = createHarness();
	await startHarness(harness);
	harness.setApproval(false);

	const [result] = await harness.emit(
		"tool_call",
		toolCall("bash", "denied-bash", { command: "whoami", execution_target: "host" }),
	);

	assert.deepEqual(result, { block: true, reason: "Host execution was denied by the user." });
	assert.equal(harness.confirmations.length, 1);
});

test("fails closed when host approval cannot be displayed", async () => {
	const harness = createHarness({ hasUI: false });
	await startHarness(harness);

	const [result] = await harness.emit(
		"tool_call",
		toolCall("read", "headless-read", { path: "README.md", execution_target: "host" }),
	);

	assert.deepEqual(result, {
		block: true,
		reason: "Host execution requires user approval, but no interactive UI is available.",
	});
	assert.equal(harness.confirmations.length, 0);
});

test("rejects execution when the approved host arguments were changed", async () => {
	const harness = createHarness();
	await startHarness(harness);
	await harness.emit(
		"tool_call",
		toolCall("read", "changed-read", { path: "README.md", execution_target: "host" }),
	);

	const readTool = harness.tools.get("read");
	assert.ok(readTool);
	await assert.rejects(
		readTool.execute(
			"changed-read",
			{ path: "package.json", execution_target: "host" },
			undefined,
			undefined,
			harness.context,
		),
		/Host execution was not approved for this exact tool call/,
	);
});

test("does not ask for approval in host fallback mode", async () => {
	const harness = createHarness({ sandbox: false });
	await startHarness(harness);
	const input = { path: "README.md", limit: 1, execution_target: "host" as const };

	const [gateResult] = await harness.emit("tool_call", toolCall("read", "fallback-read", input));
	assert.equal(gateResult, undefined);
	assert.equal(harness.confirmations.length, 0);

	const result = await harness.tools.get("read")?.execute(
		"fallback-read",
		input,
		undefined,
		undefined,
		harness.context,
	);
	assert.match(result.content[0].text, /pi-sbx/);
});

test("reads Pi-discovered skills from the host while sandboxing is active", async (t) => {
	const harness = createHarness();
	await startHarness(harness);
	const skillDirectory = await mkdtemp(path.join(tmpdir(), "pi-sbx-discovered-skill-"));
	t.after(() => rm(skillDirectory, { recursive: true, force: true }));
	const skillFile = path.join(skillDirectory, "SKILL.md");
	await writeFile(skillFile, "# Discovered host skill\n");

	await harness.emit("before_agent_start", {
		systemPrompt: "base",
		systemPromptOptions: {
			cwd: process.cwd(),
			skills: [
				{
					name: "discovered-host-skill",
					description: "test skill",
					filePath: skillFile,
					baseDir: skillDirectory,
				},
			],
		},
	});

	const result = await harness.tools.get("read")?.execute(
		"discovered-skill-read",
		{ path: skillFile },
		undefined,
		undefined,
		harness.context,
	);
	assert.match(result.content[0].text, /Discovered host skill/);
	assert.equal(harness.confirmations.length, 0);
});

test("adds opinionated host-execution guidance only when a sandbox is active", async () => {
	const extensionTools = Array.from({ length: 12 }, (_, index) => `host-tool-${String(index + 1).padStart(2, "0")}`);
	const sandboxed = createHarness({ activeTools: [...ROUTED_TOOLS, ...extensionTools] });
	await startHarness(sandboxed);
	const [sandboxPrompt] = await sandboxed.emit("before_agent_start", { systemPrompt: "base" });
	assert.match(sandboxPrompt.systemPrompt, /Use "host" only when absolutely necessary/);
	assert.match(sandboxPrompt.systemPrompt, /requires explicit user approval and interrupts the user/);
	assert.match(
		sandboxPrompt.systemPrompt,
		/Active extension tools that run on the host by default \(up to 10\): host-tool-01, host-tool-02, host-tool-03, host-tool-04, host-tool-05, host-tool-06, host-tool-07, host-tool-08, host-tool-09, host-tool-10\./,
	);
	assert.doesNotMatch(sandboxPrompt.systemPrompt, /host-tool-11|host-tool-12/);
	assert.doesNotMatch(sandboxPrompt.systemPrompt, /host by default.*\b(?:bash|read|write)\b/);

	const fallback = createHarness({ sandbox: false });
	await startHarness(fallback);
	const [fallbackPrompt] = await fallback.emit("before_agent_start", { systemPrompt: "base" });
	assert.doesNotMatch(fallbackPrompt.systemPrompt, /Use "host" only when absolutely necessary/);
	assert.match(fallbackPrompt.systemPrompt, /does not require approval in this mode/);
});
