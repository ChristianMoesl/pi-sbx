import path from "node:path";

export interface WorkspaceMount {
	hostPath: string;
	sandboxPath: string;
}

export function isWindowsPath(value: string): boolean {
	return /^[a-z]:[/\\]/i.test(value) || /^[/\\]{2}[^/\\]+[/\\][^/\\]+/.test(value);
}

/** Windows SBX mount destinations (drive letters are lowercased; UNC loses its leading double slash). */
export function sandboxWorkspacePath(workspace: string): string {
	if (!isWindowsPath(workspace)) return path.posix.normalize(workspace);
	const normalized = path.win32.normalize(workspace).replaceAll("\\", "/");
	if (/^[a-z]:\//i.test(normalized)) {
		return path.posix.normalize(`/${normalized[0]!.toLowerCase()}${normalized.slice(2)}`);
	}
	return path.posix.normalize(normalized);
}

export function relativeWithin(root: string, value: string): string | undefined {
	if (isWindowsPath(root) !== isWindowsPath(value)) return undefined;
	const paths = isWindowsPath(root) ? path.win32 : path.posix;
	if (!paths.isAbsolute(root) || !paths.isAbsolute(value)) return undefined;
	const relative = paths.relative(root, value);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative))
		? relative
		: undefined;
}

export class WorkspacePaths {
	private readonly mounts: readonly WorkspaceMount[];

	constructor(mounts: readonly WorkspaceMount[] = []) {
		this.mounts = [...mounts].sort((a, b) => b.hostPath.length - a.hostPath.length);
	}

	toSandbox(value: string): string {
		// Nested mounts must take precedence over their parents.
		for (const mount of this.mounts) {
			const relative = relativeWithin(mount.hostPath, value);
			if (relative !== undefined) {
				return path.posix.join(mount.sandboxPath, isWindowsPath(mount.hostPath) ? relative.replaceAll("\\", "/") : relative);
			}
		}
		// Unmounted Linux paths still refer to the sandbox, never to the host.
		return value;
	}
}
