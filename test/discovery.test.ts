import assert from "node:assert/strict";
import test from "node:test";
import { discoverSandboxes, parseMatchingSandboxes } from "../extensions/pi-sbx/discovery.ts";

const cwd = "/Users/example/work/repo/feature";

test("finds exact and parent mounts and sorts running sandboxes first", () => {
	const result = parseMatchingSandboxes(
		JSON.stringify({
			sandboxes: [
				{ name: "stopped", status: "stopped", workspaces: [cwd] },
				{ name: "running-z", status: "running", workspaces: ["/Users/example/work/repo"] },
				{ name: "running-a", status: "running", workspaces: [`${cwd}:ro`] },
				{ name: "other", status: "running", workspaces: ["/Users/example/work/another"] },
			],
		}),
		cwd,
	);

	assert.deepEqual(result.map((sandbox) => sandbox.name), ["running-a", "running-z", "stopped"]);
});

test("does not treat a sibling path with the same prefix as mounted", () => {
	const result = parseMatchingSandboxes(
		JSON.stringify({ sandboxes: [{ name: "wrong", workspaces: ["/Users/example/work/repo/feat"] }] }),
		cwd,
	);

	assert.deepEqual(result, []);
});

test("rejects malformed sbx output", () => {
	assert.throws(() => parseMatchingSandboxes("{}", cwd), /missing sandboxes array/);
	assert.throws(() => parseMatchingSandboxes("not json", cwd), /Could not parse/);
});

test("does not interpret relative mounts or Windows paths as local POSIX paths", () => {
	const output = JSON.stringify({ sandboxes: [
		{ name: "relative", workspaces: ["."] },
		{ name: "windows", workspaces: ["C:\\work\\repo"] },
	] });
	assert.deepEqual(parseMatchingSandboxes(output, process.cwd()), []);
	assert.throws(() => parseMatchingSandboxes("null", cwd), /missing sandboxes array/);
});

test("accepts directories starting with two dots inside a workspace", () => {
	const result = parseMatchingSandboxes(
		JSON.stringify({ sandboxes: [{ name: "valid", workspaces: ["/work"] }] }),
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
		if (command === "/windows bin/sbx.exe") {
			assert.deepEqual(args, ["ls", "--json"]);
			return { code: 0, stderr: "", killed: false, stdout: JSON.stringify({ sandboxes: [
				{ name: "test", workspaces: [unc, `${drive}:ro`] },
				{ name: "duplicate", workspaces: [unc] },
				{ name: "other-distro", workspaces: [other] },
			] }) };
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
	const exec: Parameters<typeof discoverSandboxes>[0] = async (command) => {
		assert.equal(command, "sbx");
		return { code: 0, stderr: "", killed: false, stdout: JSON.stringify({
			sandboxes: [{ name: "native", workspaces: [cwd] }],
		}) };
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
	}), "sbx.exe", cwd), /sbx\.exe ls --json timed out/);
});
