import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * Return the canonical host path when a read targets a regular file inside the
 * configured skills root. Reads outside the root remain sandboxed.
 */
export async function resolveHostSkillReadPath(
	filePath: string,
	cwd: string,
	skillsRoot: string,
): Promise<string | undefined> {
	const requestedPath = path.resolve(cwd, filePath);
	const absoluteRoot = path.resolve(skillsRoot);
	if (!isWithin(absoluteRoot, requestedPath)) return undefined;

	const [canonicalRoot, canonicalPath] = await Promise.all([realpath(absoluteRoot), realpath(requestedPath)]);
	if (!isWithin(canonicalRoot, canonicalPath)) {
		throw new Error(`Host skill read denied: ${filePath} resolves outside ${absoluteRoot}`);
	}

	const stats = await lstat(canonicalPath);
	if (!stats.isFile()) throw new Error(`Host skill read denied: ${filePath} is not a regular file`);
	return canonicalPath;
}
