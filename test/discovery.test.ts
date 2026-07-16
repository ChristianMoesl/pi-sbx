import assert from "node:assert/strict";
import test from "node:test";
import { parseMatchingSandboxes } from "../extensions/sbx-tools/discovery.ts";

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
