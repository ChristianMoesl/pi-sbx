import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { resolveHostSkillReadPath } from "../extensions/pi-sbx/skill-access.ts";

async function fixture(t: TestContext) {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-sbx-skills-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const skillsRoot = path.join(root, ".pi", "agent", "skills");
	await mkdir(path.join(skillsRoot, "example", "references"), { recursive: true });
	return { root, skillsRoot };
}

test("allows regular files below the host skills root", async (t) => {
	const { root, skillsRoot } = await fixture(t);
	const skillFile = path.join(skillsRoot, "example", "SKILL.md");
	await writeFile(skillFile, "# Example\n");

	assert.equal(await resolveHostSkillReadPath(skillFile, root, skillsRoot), skillFile);
});

test("leaves paths outside the host skills root in the sandbox", async (t) => {
	const { root, skillsRoot } = await fixture(t);
	const agentFile = path.join(root, ".pi", "agent", "AGENTS.md");
	await writeFile(agentFile, "secret");

	assert.equal(await resolveHostSkillReadPath(agentFile, root, skillsRoot), undefined);
	assert.equal(
		await resolveHostSkillReadPath(path.join(skillsRoot, "..", "AGENTS.md"), root, skillsRoot),
		undefined,
	);
});

test("rejects symlinks that escape the host skills root", async (t) => {
	const { root, skillsRoot } = await fixture(t);
	const outsideFile = path.join(root, "outside.txt");
	const skillLink = path.join(skillsRoot, "example", "references", "outside.txt");
	await writeFile(outsideFile, "secret");
	await symlink(outsideFile, skillLink);

	await assert.rejects(resolveHostSkillReadPath(skillLink, root, skillsRoot), /resolves outside/);
});

test("rejects directories", async (t) => {
	const { root, skillsRoot } = await fixture(t);
	await assert.rejects(
		resolveHostSkillReadPath(path.join(skillsRoot, "example"), root, skillsRoot),
		/not a regular file/,
	);
});
