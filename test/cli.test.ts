import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveSbxExecutable } from "../extensions/pi-sbx/cli.ts";

const posixOnly = { skip: process.platform === "win32" };

test("WSL finds sbx.exe, preferring a native sbx when both are installed", posixOnly, async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-sbx-cli with spaces-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const windowsBin = path.join(root, "windows");
	const linuxBin = path.join(root, "linux");
	await mkdir(windowsBin);
	await mkdir(linuxBin);
	const options = { platform: "linux" as const, wsl: true, env: { PATH: `${windowsBin}:${linuxBin}` } };
	await writeFile(path.join(windowsBin, "sbx.exe"), "", { mode: 0o755 });
	assert.equal(resolveSbxExecutable(options), path.join(windowsBin, "sbx.exe"));

	await writeFile(path.join(linuxBin, "sbx"), "", { mode: 0o755 });
	assert.equal(resolveSbxExecutable(options), path.join(linuxBin, "sbx"));
	await chmod(path.join(linuxBin, "sbx"), 0o644);
	assert.equal(resolveSbxExecutable(options), path.join(windowsBin, "sbx.exe"));
});

test("does not select directories or try Windows executables on non-WSL Unix", posixOnly, async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-sbx-cli-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(path.join(root, "sbx"));
	await writeFile(path.join(root, "sbx.exe"), "", { mode: 0o755 });
	for (const platform of ["linux", "darwin"] as const) {
		assert.equal(resolveSbxExecutable({ platform, wsl: false, env: { PATH: root } }), "sbx");
	}
});

test("explicit executable paths are preserved without shell parsing", () => {
	const executable = "/path with spaces/sbx.exe";
	assert.equal(resolveSbxExecutable({ env: { PI_SBX_EXECUTABLE: executable } }), executable);
});

test("uses the platform's command name when no executable is found", () => {
	assert.equal(resolveSbxExecutable({ platform: "win32", env: { Path: "Z:\\missing" } }), "sbx.exe");
	assert.equal(resolveSbxExecutable({ platform: "linux", wsl: false, env: { PATH: "/missing" } }), "sbx");
});

test("resolves relative executable overrides before changing the worker's host cwd", () => {
	assert.equal(resolveSbxExecutable({ env: { PI_SBX_EXECUTABLE: "./bin/sbx.exe" } }), path.resolve("bin/sbx.exe"));
});

test("a named override uses PATH but never falls back to a different command", posixOnly, async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-sbx-cli-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(path.join(root, "custom-sbx"), "", { mode: 0o755 });
	await writeFile(path.join(root, "sbx.exe"), "", { mode: 0o755 });
	assert.equal(resolveSbxExecutable({ env: { PATH: root, PI_SBX_EXECUTABLE: "custom-sbx" } }), path.join(root, "custom-sbx"));
	assert.equal(resolveSbxExecutable({ env: { PATH: root, PI_SBX_EXECUTABLE: "missing-sbx" } }), "missing-sbx");
});
