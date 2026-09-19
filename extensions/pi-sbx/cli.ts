import { accessSync, constants, statSync } from "node:fs";
import { release } from "node:os";
import path from "node:path";

export function isWsl(): boolean {
	return process.platform === "linux" && /microsoft/i.test(release());
}

interface ExecutableOptions {
	platform?: NodeJS.Platform;
	wsl?: boolean;
	env?: NodeJS.ProcessEnv;
}

/** Resolve once per discovery, then use the same executable for the worker. */
export function resolveSbxExecutable(options: ExecutableOptions = {}): string {
	const platform = options.platform ?? process.platform;
	const wsl = options.wsl ?? isWsl();
	const env = options.env ?? process.env;
	const paths = platform === "win32" ? path.win32 : path.posix;
	const override = env.PI_SBX_EXECUTABLE;
	if (override && (override.includes("/") || (platform === "win32" && override.includes("\\")))) {
		return paths.resolve(override);
	}

	const candidates = override ? [override] : platform === "win32" ? ["sbx.exe"] : wsl ? ["sbx", "sbx.exe"] : ["sbx"];
	const pathValue = platform === "win32"
		? Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1]
		: env.PATH;
	for (const candidate of candidates) {
		for (const directory of (pathValue ?? (platform === "win32" ? "" : "/usr/bin:/bin")).split(paths.delimiter)) {
			// Empty PATH entries denote the current directory, just as in process spawning.
			const executable = paths.resolve(directory.replace(/^"(.*)"$/, "$1"), candidate);
			try {
				accessSync(executable, platform === "win32" ? constants.F_OK : constants.X_OK);
				if (statSync(executable).isFile()) return executable;
			} catch {
				// Try the next PATH entry.
			}
		}
	}
	// Let the caller report the normal discovery failure when SBX is not installed.
	return candidates[0]!;
}
