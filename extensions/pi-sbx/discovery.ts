import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isWsl } from "./cli.ts";
import { isWindowsPath, relativeWithin, sandboxWorkspacePath, type WorkspaceMount } from "./paths.ts";

export interface SbxSandbox {
	name: string;
	id?: string;
	agent?: string;
	status?: string;
	workspaces: string[];
	mounts: WorkspaceMount[];
}

interface SbxListResponse {
	sandboxes?: unknown;
}

function mountedPath(value: string): string {
	return value.endsWith(":ro") ? value.slice(0, -3) : value;
}

function parseSandboxList(output: string): Record<string, unknown>[] {
	let parsed: SbxListResponse;
	try {
		parsed = JSON.parse(output) as SbxListResponse;
	} catch (error) {
		throw new Error(`Could not parse sbx ls --json output: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (!parsed || !Array.isArray(parsed.sandboxes)) {
		throw new Error("Could not parse sbx ls --json output: missing sandboxes array");
	}
	return parsed.sandboxes.filter((value): value is Record<string, unknown> => value !== null && typeof value === "object");
}

export function parseMatchingSandboxes(
	output: string,
	cwd: string,
	toHostPath: (workspace: string) => string | undefined = (workspace) => workspace,
): SbxSandbox[] {
	return parseSandboxList(output)
		.map((value): SbxSandbox | undefined => {
			if (typeof value.name !== "string" || !Array.isArray(value.workspaces)) return undefined;
			const workspaces = value.workspaces.filter((workspace): workspace is string => typeof workspace === "string");
			const mounts = workspaces.flatMap((workspace): WorkspaceMount[] => {
				const source = mountedPath(workspace);
				const hostPath = toHostPath(source);
				return hostPath === undefined ? [] : [{ hostPath, sandboxPath: sandboxWorkspacePath(source) }];
			});
			if (!mounts.some((mount) => relativeWithin(mount.hostPath, cwd) !== undefined)) return undefined;
			return {
				name: value.name,
				id: typeof value.id === "string" ? value.id : undefined,
				agent: typeof value.agent === "string" ? value.agent : undefined,
				status: typeof value.status === "string" ? value.status : undefined,
				workspaces,
				mounts,
			};
		})
		.filter((value): value is SbxSandbox => value !== undefined)
		.sort((left, right) => {
			const leftRunning = left.status === "running" ? 0 : 1;
			const rightRunning = right.status === "running" ? 0 : 1;
			return leftRunning - rightRunning || left.name.localeCompare(right.name);
		});
}

export async function discoverSandboxes(
	exec: ExtensionAPI["exec"],
	executable: string,
	cwd: string,
	wsl = isWsl(),
): Promise<SbxSandbox[]> {
	const result = await exec(executable, ["ls", "--json"], { timeout: 10_000 });
	if (result.code !== 0 || result.killed) {
		throw new Error(result.stderr.trim() || `${executable} ls --json ${result.killed ? "timed out" : `exited with code ${result.code}`}`);
	}
	if (!wsl) return parseMatchingSandboxes(result.stdout, cwd);

	const hostPaths = new Map<string, string>();
	const windowsWorkspaces = new Set(parseSandboxList(result.stdout).flatMap((sandbox) =>
		Array.isArray(sandbox.workspaces)
			? sandbox.workspaces.filter((value): value is string => typeof value === "string").map(mountedPath).filter(isWindowsPath)
			: [],
	));
	for (const workspace of windowsWorkspaces) {
		// wslpath understands distro aliases and custom automount roots. Never guess /mnt/<drive>.
		const converted = await exec("wslpath", ["-u", workspace], { timeout: 5_000 });
		const hostPath = converted.stdout.replace(/\r?\n$/, "");
		if (converted.code === 0 && !converted.killed && hostPath.startsWith("/")) {
			hostPaths.set(workspace, hostPath);
		}
		// A workspace in another WSL distro may not be accessible from this one.
	}
	return parseMatchingSandboxes(result.stdout, cwd, (workspace) => isWindowsPath(workspace) ? hostPaths.get(workspace) : workspace);
}
