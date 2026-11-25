import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

const CHROME_PLUGIN_CACHE_RELATIVE_PATH = ".codex/plugins/cache/openai-bundled/chrome";
const CHROME_NATIVE_MESSAGING_DIR = "Library/Application Support/Google/Chrome/NativeMessagingHosts";
const EXTENSION_HOST_BINARY_NAME = "ChatGPT for Chrome";
const DEFAULT_EXTENSION_HOST_NAME = "com.openai.codexextension";
const DEFAULT_EXTENSION_IDS = [
	"hehggadaopoacecdllhhajmbjkdcmajg",
	"odlomjlbamekndcpllcnffbgeohgkmjh",
];
const MANIFEST_DESCRIPTION = "Pi Computer Use browser native messaging host";

const extensionIdsConfigSchema = z.object({
	extensionHostName: z.string().min(1).optional(),
	extensionIds: z.array(z.string().min(1)).min(1).optional(),
});

export interface ChromeNativeHostManifestResult {
	manifestPath: string;
	hostBinaryPath: string;
	updated: boolean;
}

export interface EnsureChromeNativeHostManifestOptions {
	cuaReplConfigPath?: string;
	userHome?: string;
	arch?: string;
	verifyBinary?: (binaryPath: string) => void;
}

function hostBinaryInVersionDir(versionDir: string, arch: string): string {
	return path.join(versionDir, "extension-host", "macos", arch, EXTENSION_HOST_BINARY_NAME);
}

function resolveChromePluginVersionDir(chromeCacheRoot: string, arch: string, preferredVersion?: string): string | undefined {
	if (!existsSync(chromeCacheRoot)) return undefined;
	const candidates: string[] = [];
	if (preferredVersion) candidates.push(preferredVersion);
	candidates.push("latest");
	try {
		const entries = readdirSync(chromeCacheRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
			.map((entry) => entry.name)
			.sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
		candidates.push(...entries);
	} catch {
		return undefined;
	}
	const seen = new Set<string>();
	for (const candidate of candidates) {
		if (seen.has(candidate)) continue;
		seen.add(candidate);
		const versionDir = path.join(chromeCacheRoot, candidate);
		if (existsSync(hostBinaryInVersionDir(versionDir, arch))) return versionDir;
	}
	return undefined;
}

interface ChromeExtensionMetadata {
	hostName: string;
	extensionIds: string[];
}

function readChromeExtensionMetadata(versionDir: string): ChromeExtensionMetadata {
	const configPath = path.join(versionDir, "scripts", "extension-ids.json");
	if (!existsSync(configPath)) {
		return { hostName: DEFAULT_EXTENSION_HOST_NAME, extensionIds: DEFAULT_EXTENSION_IDS };
	}
	try {
		const parsed = extensionIdsConfigSchema.safeParse(JSON.parse(readFileSync(configPath, "utf8")));
		if (parsed.success) {
			return {
				hostName: parsed.data.extensionHostName ?? DEFAULT_EXTENSION_HOST_NAME,
				extensionIds: parsed.data.extensionIds ?? DEFAULT_EXTENSION_IDS,
			};
		}
	} catch {
		return { hostName: DEFAULT_EXTENSION_HOST_NAME, extensionIds: DEFAULT_EXTENSION_IDS };
	}
	return { hostName: DEFAULT_EXTENSION_HOST_NAME, extensionIds: DEFAULT_EXTENSION_IDS };
}

export function ensureChromeNativeHostManifest(
	options: EnsureChromeNativeHostManifestOptions = {},
): ChromeNativeHostManifestResult | undefined {
	const arch = options.arch ?? os.arch();
	if (arch !== "arm64" && arch !== "x64") return undefined;
	const userHome = options.userHome ?? os.userInfo().homedir;
	const chromeCacheRoot = path.join(userHome, CHROME_PLUGIN_CACHE_RELATIVE_PATH);
	const preferredVersion = options.cuaReplConfigPath
		? path.basename(path.dirname(options.cuaReplConfigPath))
		: undefined;
	const versionDir = resolveChromePluginVersionDir(chromeCacheRoot, arch, preferredVersion);
	if (!versionDir) return undefined;

	const hostBinaryPath = realpathSync(hostBinaryInVersionDir(versionDir, arch));
	options.verifyBinary?.(hostBinaryPath);

	const { hostName, extensionIds } = readChromeExtensionMetadata(versionDir);
	const manifestPath = path.join(userHome, CHROME_NATIVE_MESSAGING_DIR, `${hostName}.json`);
	const manifest = {
		allowed_origins: [...new Set(extensionIds.map((id) => `chrome-extension://${id}/`))],
		description: MANIFEST_DESCRIPTION,
		name: hostName,
		path: hostBinaryPath,
		type: "stdio",
	};
	const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
	if (existsSync(manifestPath)) {
		try {
			if (readFileSync(manifestPath, "utf8") === serialized) {
				return { manifestPath, hostBinaryPath, updated: false };
			}
		} catch {
		}
	}

	const manifestDir = path.dirname(manifestPath);
	mkdirSync(manifestDir, { recursive: true });
	const tempPath = path.join(manifestDir, `.${hostName}.json.tmp.${process.pid}.${randomUUID()}`);
	try {
		writeFileSync(tempPath, serialized, { encoding: "utf8", mode: 0o644 });
		renameSync(tempPath, manifestPath);
	} catch (error) {
		rmSync(tempPath, { force: true });
		throw error;
	}
	return { manifestPath, hostBinaryPath, updated: true };
}
