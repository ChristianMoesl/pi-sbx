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


test("published package includes the image readiness contract", async () => {
	assert.ok(manifest.files.includes("docs"));
	const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
	assert.match(readme, /\(docs\/readiness\.md\)/);
	const contract = await readFile(new URL("../docs/readiness.md", import.meta.url), "utf8");
	assert.match(contract, /sandbox-startup wait --timeout 60/);
});
