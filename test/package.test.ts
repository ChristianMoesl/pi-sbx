import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

for (const name of ["@earendil-works/pi-coding-agent", "typebox"]) {
	test(`${name} is supplied by Pi at runtime and installed only for development`, () => {
		assert.equal(manifest.dependencies?.[name], undefined, `${name} must not be a runtime dependency`);
		assert.equal(manifest.peerDependencies?.[name], "*", `${name} must accept the host-provided version`);
		assert.equal(typeof manifest.devDependencies?.[name], "string", `${name} is needed for local checks`);
	});
}
