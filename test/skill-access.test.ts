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

test("allows canonical and alternate directory aliases of a discovered skill", async (t) => {
	const { root, skillDirectory, skillFile } = await fixture(t);
	const advertisedDirectory = path.join(root, "advertised");
	const alternateDirectory = path.join(root, "alternate");
	await symlink(skillDirectory, advertisedDirectory);
	await symlink(skillDirectory, alternateDirectory);
	const skill: DiscoveredSkillPath = {
		filePath: path.join(advertisedDirectory, "SKILL.md"),
		baseDir: advertisedDirectory,
	};
	const referenceFile = path.join(skillDirectory, "references", "api.md");
	await writeFile(referenceFile, "# API\n");

	for (const directory of [advertisedDirectory, skillDirectory, alternateDirectory]) {
		assert.equal(await resolveHostSkillReadPath(path.join(directory, "SKILL.md"), root, [skill]), await realpath(skillFile));
		assert.equal(await resolveHostSkillReadPath(path.join(directory, "references", "api.md"), root, [skill]), await realpath(referenceFile));
	}
});

test("leaves missing paths outside discovered skills in the sandbox", async (t) => {
	const { root, skill } = await fixture(t);
	const unrelatedFile = path.join(root, "unrelated.txt");
	await writeFile(unrelatedFile, "secret");

	assert.equal(await resolveHostSkillReadPath(path.join(root, "sandbox-only.txt"), root, [skill]), undefined);
	assert.equal(await resolveHostSkillReadPath(path.join(unrelatedFile, "not-a-directory.txt"), root, [skill]), undefined);
});

test("preserves missing-path errors within a discovered skill", async (t) => {
	const { root, skill, skillDirectory } = await fixture(t);

	await assert.rejects(
		resolveHostSkillReadPath(path.join(skillDirectory, "missing.md"), root, [skill]),
		{ code: "ENOENT" },
	);
	await rm(skill.filePath);
	await assert.rejects(resolveHostSkillReadPath(skill.filePath, root, [skill]), { code: "ENOENT" });
});

test("unavailable unrelated discovered skills do not break sandbox reads", async (t) => {
	const { root } = await fixture(t);
	const skill: DiscoveredSkillPath = { filePath: path.join(root, "missing", "SKILL.md"), baseDir: path.join(root, "missing") };
	const unrelatedFile = path.join(root, "unrelated.txt");
	await writeFile(unrelatedFile, "secret");

	assert.equal(await resolveHostSkillReadPath(unrelatedFile, root, [skill]), undefined);
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

test("standalone Markdown aliases authorize only the discovered file, not siblings", async (t) => {
	const { root } = await fixture(t);
	const directory = path.join(root, "standalone");
	const advertisedDirectory = path.join(root, "advertised");
	await mkdir(directory);
	await symlink(directory, advertisedDirectory);
	const skillFile = path.join(directory, "example.md");
	const siblingFile = path.join(directory, "secret.txt");
	await writeFile(skillFile, "# Standalone\n");
	await writeFile(siblingFile, "secret");
	const skill: DiscoveredSkillPath = { filePath: path.join(advertisedDirectory, "example.md"), baseDir: advertisedDirectory };

	assert.equal(await resolveHostSkillReadPath(skillFile, root, [skill]), await realpath(skillFile));
	for (const baseDir of [directory, advertisedDirectory]) {
		assert.equal(await resolveHostSkillReadPath(path.join(baseDir, "secret.txt"), root, [skill]), undefined);
	}
});

test("does not authorize symlink escapes through discovered or alias directories", async (t) => {
	const { root, skillDirectory } = await fixture(t);
	const advertisedDirectory = path.join(root, "advertised");
	const alternateDirectory = path.join(root, "alternate");
	await symlink(skillDirectory, advertisedDirectory);
	await symlink(skillDirectory, alternateDirectory);
	const skill: DiscoveredSkillPath = { filePath: path.join(advertisedDirectory, "SKILL.md"), baseDir: advertisedDirectory };
	const outsideFile = path.join(root, "outside.txt");
	const outsideDirectory = path.join(root, "outside");
	await writeFile(outsideFile, "secret");
	await mkdir(outsideDirectory);
	await writeFile(path.join(outsideDirectory, "secret.txt"), "secret");
	await symlink(outsideFile, path.join(skillDirectory, "references", "escape.txt"));
	await symlink(outsideDirectory, path.join(skillDirectory, "references", "escape-dir"));

	for (const suffix of ["escape.txt", path.join("escape-dir", "secret.txt")]) {
		await assert.rejects(resolveHostSkillReadPath(path.join(advertisedDirectory, "references", suffix), root, [skill]), /resolves outside/);
		for (const baseDir of [skillDirectory, alternateDirectory]) {
			assert.equal(await resolveHostSkillReadPath(path.join(baseDir, "references", suffix), root, [skill]), undefined);
		}
	}
	assert.equal(await resolveHostSkillReadPath(path.join(alternateDirectory, "missing.md"), root, [skill]), undefined);
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
	assert.equal(await resolveHostSkillReadPath(targetFile, root, [skill]), await realpath(targetFile));
	const siblingFile = path.join(path.dirname(targetFile), "secret.txt");
	await writeFile(siblingFile, "secret");
	assert.equal(await resolveHostSkillReadPath(siblingFile, root, [skill]), undefined);
});

test("rejects directories", async (t) => {
	const { root, skill, skillDirectory } = await fixture(t);
	await assert.rejects(
		resolveHostSkillReadPath(path.join(skillDirectory, "references"), root, [skill]),
		/not a regular file/,
	);
});
