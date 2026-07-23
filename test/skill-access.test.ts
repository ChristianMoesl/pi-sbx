import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
	type DiscoveredSkillPath,
	resolveHostSkillReadPath,
} from "../extensions/pi-sbx/skill-access.ts";

async function fixture(t: TestContext) {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-sbx-skills-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const skillDirectory = path.join(root, "custom", "example");
	const skillFile = path.join(skillDirectory, "SKILL.md");
	await mkdir(path.join(skillDirectory, "references"), { recursive: true });
	await writeFile(skillFile, "# Example\n");
	const skill: DiscoveredSkillPath = { filePath: skillFile, baseDir: skillDirectory };
	return { root, skill, skillDirectory, skillFile };
}

test("allows discovered skill files from arbitrary locations", async (t) => {
	const { root, skill, skillFile } = await fixture(t);

	assert.equal(await resolveHostSkillReadPath(skillFile, root, [skill]), await realpath(skillFile));
});

test("allows supporting files below a discovered directory skill", async (t) => {
	const { root, skill, skillDirectory } = await fixture(t);
	const referenceFile = path.join(skillDirectory, "references", "api.md");
	await writeFile(referenceFile, "# API\n");

	assert.equal(await resolveHostSkillReadPath(referenceFile, root, [skill]), await realpath(referenceFile));
});

test("leaves files outside discovered skills in the sandbox", async (t) => {
	const { root, skill } = await fixture(t);
	const unrelatedFile = path.join(root, "custom", "unrelated.txt");
	await writeFile(unrelatedFile, "secret");

	assert.equal(await resolveHostSkillReadPath(unrelatedFile, root, [skill]), undefined);
});

test("only allows the discovered file for a standalone Markdown skill", async (t) => {
	const { root } = await fixture(t);
	const skillsDirectory = path.join(root, "standalone-skills");
	const skillFile = path.join(skillsDirectory, "example.md");
	const siblingFile = path.join(skillsDirectory, "secret.txt");
	await mkdir(skillsDirectory, { recursive: true });
	await writeFile(skillFile, "# Example\n");
	await writeFile(siblingFile, "secret");
	const skill: DiscoveredSkillPath = { filePath: skillFile, baseDir: skillsDirectory };

	assert.equal(await resolveHostSkillReadPath(skillFile, root, [skill]), await realpath(skillFile));
	assert.equal(await resolveHostSkillReadPath(siblingFile, root, [skill]), undefined);
});

test("rejects symlinks that escape a discovered skill directory", async (t) => {
	const { root, skill, skillDirectory } = await fixture(t);
	const outsideFile = path.join(root, "outside.txt");
	const skillLink = path.join(skillDirectory, "references", "outside.txt");
	await writeFile(outsideFile, "secret");
	await symlink(outsideFile, skillLink);

	await assert.rejects(resolveHostSkillReadPath(skillLink, root, [skill]), /resolves outside/);
});

test("allows an exact discovered skill file that is a symlink", async (t) => {
	const { root } = await fixture(t);
	const targetFile = path.join(root, "shared", "SKILL.md");
	const skillFile = path.join(root, "configured", "SKILL.md");
	await mkdir(path.dirname(targetFile), { recursive: true });
	await mkdir(path.dirname(skillFile), { recursive: true });
	await writeFile(targetFile, "# Shared skill\n");
	await symlink(targetFile, skillFile);
	const skill: DiscoveredSkillPath = { filePath: skillFile, baseDir: path.dirname(skillFile) };

	assert.equal(await resolveHostSkillReadPath(skillFile, root, [skill]), await realpath(targetFile));
});

test("rejects directories", async (t) => {
	const { root, skill, skillDirectory } = await fixture(t);
	await assert.rejects(
		resolveHostSkillReadPath(path.join(skillDirectory, "references"), root, [skill]),
		/not a regular file/,
	);
});
