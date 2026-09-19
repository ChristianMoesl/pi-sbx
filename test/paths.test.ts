import assert from "node:assert/strict";
import test from "node:test";
import { relativeWithin, sandboxWorkspacePath, WorkspacePaths } from "../extensions/pi-sbx/paths.ts";

test("converts Windows drive and WSL UNC mount destinations to Linux paths", () => {
	assert.equal(sandboxWorkspacePath("C:\\Users\\Example User\\repo"), "/c/Users/Example User/repo");
	assert.equal(sandboxWorkspacePath("D:/work/repo/"), "/d/work/repo/");
	assert.equal(sandboxWorkspacePath("\\\\wsl.localhost\\Ubuntu\\home\\user\\repo"), "/wsl.localhost/Ubuntu/home/user/repo");
	assert.equal(sandboxWorkspacePath("\\\\wsl$\\Ubuntu\\home\\user\\repo"), "/wsl$/Ubuntu/home/user/repo");
	assert.equal(sandboxWorkspacePath("/Users/example/repo"), "/Users/example/repo");
});

test("maps host paths only at directory boundaries and preserves sandbox-only paths", () => {
	const paths = new WorkspacePaths([
		{ hostPath: "/home/user/repo", sandboxPath: "/wsl.localhost/Ubuntu/home/user/repo" },
		{ hostPath: "/mnt/c/Work", sandboxPath: "/c/Work" },
	]);
	assert.equal(paths.toSandbox("/home/user/repo"), "/wsl.localhost/Ubuntu/home/user/repo");
	assert.equal(paths.toSandbox("/home/user/repo/src/../a b.txt"), "/wsl.localhost/Ubuntu/home/user/repo/a b.txt");
	assert.equal(paths.toSandbox("/home/user/repo/..hidden/a"), "/wsl.localhost/Ubuntu/home/user/repo/..hidden/a");
	assert.equal(paths.toSandbox("/mnt/c/Work/src/a.txt"), "/c/Work/src/a.txt");
	for (const value of ["/home/user/repository", "/home/user/repo/../private", "/etc/hosts", "/c/Work/src/a.txt"]) {
		assert.equal(paths.toSandbox(value), value);
	}
});

test("prefers nested mounts and preserves case-sensitive WSL paths", () => {
	const paths = new WorkspacePaths([
		{ hostPath: "/work", sandboxPath: "/outer" },
		{ hostPath: "/work/project", sandboxPath: "/inner" },
	]);
	assert.equal(paths.toSandbox("/work/project/file"), "/inner/file");
	assert.equal(paths.toSandbox("/work/Project/file"), "/outer/Project/file");
	assert.equal(paths.toSandbox("/Work/project/file"), "/Work/project/file");
});

test("compares Windows host paths independently of the test host OS", () => {
	const paths = new WorkspacePaths([{ hostPath: "C:\\Work\\Repo", sandboxPath: "/c/Work/Repo" }]);
	assert.equal(paths.toSandbox("c:/work/repo/src/test.ts"), "/c/Work/Repo/src/test.ts");
	assert.equal(paths.toSandbox("D:\\Work\\Repo\\test.ts"), "D:\\Work\\Repo\\test.ts");
	assert.equal(relativeWithin("C:\\Work\\Repo", "C:\\Work\\Repository"), undefined);
	assert.equal(relativeWithin("repo", "/work/repo"), undefined);
	assert.equal(relativeWithin("C:\\work", "/work"), undefined);
});
