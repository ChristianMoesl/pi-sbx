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
 */
export async function resolveHostSkillReadPath(
	filePath: string,
	cwd: string,
	discoveredSkills: readonly DiscoveredSkillPath[],
): Promise<string | undefined> {
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

	if (exactSkillFiles.size === 0 && skillDirectories.length === 0) return undefined;

	const canonicalPath = await realpath(requestedPath);
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
