import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export interface DiscoveredSkillPath {
	filePath: string;
	baseDir: string;
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * Return the canonical host path when a read targets a discovered skill.
 * Directory-based skills may read supporting files below their base directory;
 * standalone Markdown skills may only read the discovered file itself.
 * Alternate spellings must resolve to the same file or contained supporting files.
 */
export async function resolveHostSkillReadPath(
	filePath: string,
	cwd: string,
	discoveredSkills: readonly DiscoveredSkillPath[],
): Promise<string | undefined> {
	if (discoveredSkills.length === 0) return undefined;
	const requestedPath = path.resolve(cwd, filePath);
	const exactSkillFiles = new Set<string>();
	const skillDirectories: string[] = [];

	for (const skill of discoveredSkills) {
		const skillFile = path.resolve(skill.filePath);
		if (requestedPath === skillFile) exactSkillFiles.add(skillFile);
		if (path.basename(skillFile) === "SKILL.md") {
			const skillDirectory = path.resolve(skill.baseDir);
			if (isWithin(skillDirectory, requestedPath)) skillDirectories.push(skillDirectory);
		}
	}

	const lexicallyMatched = exactSkillFiles.size > 0 || skillDirectories.length > 0;
	const canonicalPath = await realpath(requestedPath).catch((error) => {
		// An ordinary sandbox path need not exist or be accessible on the host.
		// Preserve errors for reads already identified as discovered skill paths.
		if (lexicallyMatched) throw error;
		return undefined;
	});
	if (!canonicalPath) return undefined;

	if (!lexicallyMatched) {
		// Probe canonical identity, not additional skill roots. Unavailable unrelated
		// skills must not prevent an ordinary read from reaching the sandbox.
		for (const skill of discoveredSkills) {
			const skillFile = path.resolve(skill.filePath);
			if ((await realpath(skillFile).catch(() => undefined)) === canonicalPath) exactSkillFiles.add(skillFile);
			if (path.basename(skillFile) === "SKILL.md") {
				const skillDirectory = path.resolve(skill.baseDir);
				const canonicalDirectory = await realpath(skillDirectory).catch(() => undefined);
				if (canonicalDirectory && isWithin(canonicalDirectory, canonicalPath)) skillDirectories.push(skillDirectory);
			}
		}
		if (exactSkillFiles.size === 0 && skillDirectories.length === 0) return undefined;
	}
	for (const skillFile of exactSkillFiles) {
		if ((await realpath(skillFile)) === canonicalPath) {
			const stats = await lstat(canonicalPath);
			if (!stats.isFile()) throw new Error(`Host skill read denied: ${filePath} is not a regular file`);
			return canonicalPath;
		}
	}

	for (const skillDirectory of skillDirectories) {
		const canonicalDirectory = await realpath(skillDirectory);
		if (!isWithin(canonicalDirectory, canonicalPath)) continue;
		const stats = await lstat(canonicalPath);
		if (!stats.isFile()) throw new Error(`Host skill read denied: ${filePath} is not a regular file`);
		return canonicalPath;
	}

	throw new Error(`Host skill read denied: ${filePath} resolves outside its discovered skill directory`);
}
