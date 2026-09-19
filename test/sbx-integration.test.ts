import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piSbxExtension from "../extensions/pi-sbx/index.ts";

const workspace = process.env.PI_SBX_TEST_WORKSPACE;

// Opt-in: requires a real SBX sandbox mounting this workspace. No sandbox is
// created or removed here; only a unique temporary directory under the mount.
test("real SBX routes all tools and user bash through mapped workspaces", { skip: !workspace }, async (t) => {
	const originalCwd = process.cwd();
	const directory = await mkdtemp(path.join(path.resolve(workspace!), "pi-sbx-tools-"));
	const tools = new Map<string, any>();
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
	let status = "";
	const context = {
		hasUI: false,
		cwd: directory,
		sessionManager: { getBranch: () => [] },
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: (_id: string, text: string) => { status = text; },
			notify: () => {},
		},
	} as unknown as ExtensionContext;
	const exec: ExtensionAPI["exec"] = async (command, args, options) => {
		try {
			const result = await promisify(execFile)(command, args, { timeout: options?.timeout });
			return { ...result, code: 0, killed: false };
		} catch (error) {
			const failure = error as Error & { code?: number; stdout?: string; stderr?: string; killed?: boolean };
			return { code: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message, killed: failure.killed ?? false };
		}
	};
	t.after(async () => {
		await handlers.get("session_shutdown")?.({}, context);
		process.chdir(originalCwd);
		await rm(directory, { recursive: true, force: true });
	});
	process.chdir(directory);
	piSbxExtension({
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: () => {},
		on: (event: string, handler: any) => handlers.set(event, handler),
		appendEntry: () => {},
		getActiveTools: () => [...tools.keys()],
		exec,
	} as unknown as ExtensionAPI);
	await handlers.get("session_start")!({}, context);
	assert.match(status, /^sbx: /);
	assert.doesNotMatch(status, /host fallback/, "integration test must never silently run on the host");

	let callId = 0;
	async function call(name: string, input: object): Promise<string> {
		const result = await tools.get(name).execute(String(++callId), input, undefined, undefined, context);
		return result.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
	}
	const sandboxCwd = (await call("bash", { command: "pwd" })).trim();
	const prompt = await handlers.get("before_agent_start")!({ systemPrompt: `Current working directory: ${directory}` }, context);
	assert.ok(prompt.systemPrompt.includes(`Current working directory: ${sandboxCwd}`));
	assert.ok(prompt.systemPrompt.includes(`Sandbox working directory: ${sandboxCwd}`));

	const file = "nested/space ' café.txt";
	const content = "alpha\nC:\\opaque\\content\n";
	await call("write", { path: file, content });
	assert.equal(await readFile(path.join(directory, file), "utf8"), content);
	assert.match(await call("read", { path: path.join(directory, file) }), /alpha/);
	assert.match(await call("read", { path: path.posix.join(sandboxCwd, file) }), /C:\\opaque\\content/);
	await call("edit", { path: file, edits: [{ oldText: "alpha", newText: "beta" }] });
	assert.equal(await readFile(path.join(directory, file), "utf8"), content.replace("alpha", "beta"));
	assert.match(await call("ls", {}), /nested\//);
	assert.match(await call("ls", { path: "nested" }), /space ' café\.txt/);
	for (const searchPath of [directory, sandboxCwd]) {
		assert.equal((await call("find", { pattern: "*.txt", path: searchPath })).trim(), file);
		assert.equal((await call("grep", { pattern: "beta", path: searchPath })).trim(), `${file}:1: beta`);
	}
	assert.equal(await call("bash", { command: "printf '%s' $'first\\nsecond'" }), "first\nsecond");

	const userBash = await handlers.get("user_bash")!({}, context);
	const chunks: Buffer[] = [];
	const result = await userBash.operations.exec("pwd", directory, { onData: (data: Buffer) => chunks.push(data) });
	assert.equal(result.exitCode, 0);
	assert.equal(Buffer.concat(chunks).toString().trim(), sandboxCwd);
	await assert.rejects(call("bash", { command: "sleep 10", timeout: 0.1 }), /timed out|timeout/i);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 100);
	try {
		await assert.rejects(tools.get("bash").execute("abort", { command: "sleep 10" }, controller.signal), /aborted/i);
	} finally {
		clearTimeout(timer);
	}
	assert.match(await call("read", { path: file }), /beta/);
});
