import path from "node:path";

export interface SbxSandbox {
	name: string;
	id?: string;
	agent?: string;
	status?: string;
	workspaces: string[];
}

interface SbxListResponse {
	sandboxes?: unknown;
}

function mountedPath(value: string): string {
	return value.endsWith(":ro") ? value.slice(0, -3) : value;
}

function containsPath(root: string, value: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(value));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function parseMatchingSandboxes(output: string, cwd: string): SbxSandbox[] {
	let parsed: SbxListResponse;
	try {
		parsed = JSON.parse(output) as SbxListResponse;
	} catch (error) {
		throw new Error(`Could not parse sbx ls --json output: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (!Array.isArray(parsed.sandboxes)) {
		throw new Error("Could not parse sbx ls --json output: missing sandboxes array");
	}

	return parsed.sandboxes
		.filter((value): value is Record<string, unknown> => value !== null && typeof value === "object")
		.map((value): SbxSandbox | undefined => {
			if (typeof value.name !== "string" || !Array.isArray(value.workspaces)) return undefined;
			const workspaces = value.workspaces.filter((workspace): workspace is string => typeof workspace === "string");
			if (!workspaces.some((workspace) => containsPath(mountedPath(workspace), cwd))) return undefined;
			return {
				name: value.name,
				id: typeof value.id === "string" ? value.id : undefined,
				agent: typeof value.agent === "string" ? value.agent : undefined,
				status: typeof value.status === "string" ? value.status : undefined,
				workspaces,
			};
		})
		.filter((value): value is SbxSandbox => value !== undefined)
		.sort((left, right) => {
			const leftRunning = left.status === "running" ? 0 : 1;
			const rightRunning = right.status === "running" ? 0 : 1;
			return leftRunning - rightRunning || left.name.localeCompare(right.name);
		});
}
