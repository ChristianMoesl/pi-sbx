import assert from "node:assert/strict";
import test from "node:test";
import { discoverSandboxes, parseMatchingSandboxes, validateSbxVersion } from "../extensions/pi-sbx/discovery.ts";

const cwd = "/Users/example/work/repo/feature";

test("finds exact and parent mounts and sorts running sandboxes first", () => {
	const result = parseMatchingSandboxes(
		JSON.stringify([
			{ name: "stopped", status: "stopped", workspaces: [cwd] },
			{ name: "running-z", status: "running", workspaces: ["/Users/example/work/repo"] },
			{ name: "running-a", status: "running", workspaces: [`${cwd}:ro`] },
			{ name: "other", status: "running", workspaces: ["/Users/example/work/another"] },
		]),
		cwd,
	);

	assert.deepEqual(result.map((sandbox) => sandbox.name), ["running-a", "running-z", "stopped"]);
});

test("does not treat a sibling path with the same prefix as mounted", () => {
	const result = parseMatchingSandboxes(
		JSON.stringify([{ name: "wrong", workspaces: ["/Users/example/work/repo/feat"] }]),
		cwd,
	);

	assert.deepEqual(result, []);
});

test("rejects malformed sbx output", () => {
	assert.throws(() => parseMatchingSandboxes("{}", cwd), /expected a sandbox array/);
	assert.throws(() => parseMatchingSandboxes("not json", cwd), /Could not parse/);
});

test("does not interpret relative mounts or Windows paths as local POSIX paths", () => {
	const output = JSON.stringify([
		{ name: "relative", workspaces: ["."] },
		{ name: "windows", workspaces: ["C:\\work\\repo"] },
	]);
	assert.deepEqual(parseMatchingSandboxes(output, process.cwd()), []);
	assert.throws(() => parseMatchingSandboxes("null", cwd), /expected a sandbox array/);
});

test("accepts directories starting with two dots inside a workspace", () => {
	const result = parseMatchingSandboxes(
		JSON.stringify([{ name: "valid", workspaces: ["/work"] }]),
		"/work/..hidden",
	);
	assert.equal(result[0]?.name, "valid");
});

test("WSL discovery translates Windows workspaces using wslpath, including custom automount roots", async () => {
	const unc = "\\\\wsl.localhost\\Ubuntu\\home\\user\\repo";
	const drive = "C:\\work\\shared docs";
	const other = "\\\\wsl.localhost\\OtherDistro\\home\\user\\repo";
	const calls: Array<[string, string[]]> = [];
	const exec: Parameters<typeof discoverSandboxes>[0] = async (command, args) => {
		calls.push([command, args]);
        if(args[0]==="version") return {code:0,stderr:"",killed:false,stdout:'{"client":{"version":"v0.48.0"}}'};
		if (command === "/windows bin/sbx.exe") {
			assert.deepEqual(args, ["ls", "--json"]);
			return { code: 0, stderr: "", killed: false, stdout: JSON.stringify([
				{ name: "test", workspaces: [unc, `${drive}:ro`] },
				{ name: "duplicate", workspaces: [unc] },
				{ name: "other-distro", workspaces: [other] },
			]) };
		}
		assert.equal(command, "wslpath");
		assert.equal(args[0], "-u");
		const converted = args[1] === unc ? "/home/user/repo" : args[1] === drive ? "/custom/c/work/shared docs" : undefined;
		return { code: converted ? 0 : 1, stdout: converted ? `${converted}\r\n` : "", stderr: "", killed: false };
	};
	const result = await discoverSandboxes(exec, "/windows bin/sbx.exe", "/home/user/repo/subdir", true);
	assert.deepEqual(result.map((sandbox) => sandbox.name), ["duplicate", "test"]);
	assert.deepEqual(result.find((sandbox) => sandbox.name === "test")?.mounts, [
		{ hostPath: "/home/user/repo", sandboxPath: "/wsl.localhost/Ubuntu/home/user/repo" },
		{ hostPath: "/custom/c/work/shared docs", sandboxPath: "/c/work/shared docs" },
	]);
	assert.equal(calls.filter(([command]) => command === "wslpath").length, 3);
});

test("POSIX discovery does not invoke wslpath", async () => {
	const exec: Parameters<typeof discoverSandboxes>[0] = async (command, args) => {
        if(args.includes("version")) return {code:0,stderr:"",killed:false,stdout:'{"client":{"version":"v0.48.0"}}'};
		assert.ok(command === "sbx" || command === "env");
		return { code: 0, stderr: "", killed: false, stdout: JSON.stringify([{ name: "native", workspaces: [cwd] }]) };
	};
	assert.equal((await discoverSandboxes(exec, "sbx", cwd, false))[0]?.name, "native");
	assert.equal((await discoverSandboxes(exec, "sbx", cwd, true))[0]?.name, "native");
});

test("discovery reports CLI failures and timeouts rather than trying another installation", async () => {
	await assert.rejects(discoverSandboxes(async () => ({
		code: 1, killed: false, stdout: "", stderr: "daemon unavailable",
	}), "sbx.exe", cwd), /daemon unavailable/);
	await assert.rejects(discoverSandboxes(async () => ({
		code: 0, killed: true, stdout: "", stderr: "",
	}), "sbx.exe", cwd), /sbx\.exe version --json timed out/);
});

test("discovery forwards cancellation and does not accept results after cancellation", async () => {
	const controller = new AbortController();
	let calls = 0;
	await assert.rejects(discoverSandboxes(async (_command, _args, options) => {
		calls++;
		assert.equal(options?.signal, controller.signal);
		assert.ok(options!.timeout! > 0 && options!.timeout! <= 1_000);
		controller.abort();
		return { code: 0, killed: false, stderr: "", stdout: JSON.stringify([]) };
	}, "sbx", cwd, false, { signal: controller.signal, timeoutMs: 1_000 }), /aborted/);
	assert.equal(calls, 1);
});

test("already cancelled discovery never spawns a command", async () => {
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(discoverSandboxes(async () => {
		assert.fail("must not execute after cancellation");
	}, "sbx", cwd, false, { signal: controller.signal }), /aborted/);
});

test("empty inventories are valid, malformed rows cannot masquerade as absence", () => {
 assert.deepEqual(parseMatchingSandboxes("[]", cwd), []);
 for(const entry of [null,42,"invalid",{},{name:"missing-mounts"},{name:"bad-path",workspaces:[3]}]) {
  assert.throws(()=>parseMatchingSandboxes(JSON.stringify([entry]),cwd),/rows require/);
 }
});

test("rejects the pre-0.48 wrapper with protocol guidance", () => {
	assert.throws(() => parseMatchingSandboxes('{"sandboxes":[]}', cwd), /expected a sandbox array/);
});


test("accepts stable SBX versions from 0.48.0 without an upper bound", () => {
	for (const version of ["v0.48.0", "0.48.9", "v0.49.0", "v0.50.0", "v1.0.0", "v2.0.0"]) {
		assert.doesNotThrow(() => validateSbxVersion(JSON.stringify({ client: { version } })));
	}
	for (const output of ["bad", "null", "{}", ...["v0.46.0", "v0.47.99", "v0.48.0-rc.3", "v1.0.-1", "v-1.50.0"].map(version => JSON.stringify({ client: { version } }))]) {
		assert.throws(() => validateSbxVersion(output), /SBX 0\.48\.0 or newer required/);
	}
});

test("unsupported versions fail before discovery or fallback", async () => {
	let calls = 0;
	await assert.rejects(discoverSandboxes(async () => {
		calls++;
		return { code: 0, stderr: "", killed: false, stdout: '{"client":{"version":"v0.47.9"}}' };
	}, "sbx", cwd, false), /SBX 0\.48\.0 or newer required/);
	assert.equal(calls, 1, "version failures must not proceed to discovery or another executable");
});

test("newer versions reach discovery and still require the sandbox array contract", async () => {
	for (const version of ["v0.50.0", "v1.0.0"]) {
		for (const output of [JSON.stringify([{ name: "native", workspaces: [cwd] }]), '{"sandboxes":[]}']) {
			const calls: string[][] = [];
			const exec: Parameters<typeof discoverSandboxes>[0] = async (_command, args) => {
				calls.push(args);
				return { code: 0, stderr: "", killed: false, stdout: args[0] === "version" ? JSON.stringify({ client: { version } }) : output };
			};
			if (output.startsWith("[")) {
				assert.equal((await discoverSandboxes(exec, "sbx", cwd, false))[0]?.name, "native");
			} else {
				await assert.rejects(discoverSandboxes(exec, "sbx", cwd, false), /expected a sandbox array/);
			}
			assert.deepEqual(calls, [["version", "--json"], ["ls", "--json"]]);
		}
	}
});
