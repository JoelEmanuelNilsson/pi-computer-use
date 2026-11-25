import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { ensureChromeNativeHostManifest } from "./chrome-native-host-manifest.ts";
import { unexpectedLsofStderr } from "./lsof-stderr.ts";
import { stripConfirmationPolicyBlocks } from "./result-sanitizer.ts";
import type { CuaReplArguments, CuaReplTool, JsonObject, JsonValue } from "./tools.ts";
import { PACKAGE_VERSION } from "./version.ts";

const APP_SERVER_RELATIVE_PATHS = [
	"Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
	"Contents/Resources/codex",
];
const COMPUTER_USE_APP_RELATIVE_PATH = "computer-use/Codex Computer Use.app";
const SERVICE_RELATIVE_PATH = "Contents/MacOS/SkyComputerUseService";
const NATIVE_CLIENT_RELATIVE_PATH = "Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient";
const CUA_REPL_CACHE_RELATIVE_PATH = ".codex/plugins/cache/openai-bundled/unified-computer-use";
const CUA_REPL_SERVER = "cua_repl";
const RUNTIME_APP_BUNDLE_ID = "com.openai.codex";
const RUNTIME_SIGNING_TEAM_ID = "2DC432GLL2";
const VERIFY_COMMAND_TIMEOUT_MS = 30_000;
const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g");

function outOfStepHint(appServerVersion?: string): string {
	const versions = `pi-computer-use ${PACKAGE_VERSION}${appServerVersion ? `, ${appServerVersion}` : ""}`;
	return `Pi Computer Use and its underlying macOS runtime may be out of step (${versions}). Open the ChatGPT desktop app (\`open -a ChatGPT\`) so it can install runtime updates, update pi-computer-use, restart Pi or the MCP client, then retry. If it still fails, tell the user.`;
}

export const STUCK_SERVICE_ERROR = "Sky Computer Use native pipe startup failed";
const STUCK_SERVICE_HINT = "The Pi Computer Use background service may be stuck. Restart it with `pkill -f MacOS/SkyComputerUseService` (it relaunches on the next call), then retry once. If it fails again, ask the user to relaunch the ChatGPT desktop app, which provides the runtime.";

const jsonObjectSchema = z.record(z.string(), z.json());
const elicitationRequestSchema = z.object({
	mode: z.string().optional(),
	message: z.string().optional(),
	requestedSchema: z.json().optional(),
	url: z.string().optional(),
	elicitationId: z.string().optional(),
	_meta: z.json().optional(),
}).catchall(z.json());
const directResultSchema = z.object({
	content: z.array(jsonObjectSchema),
	structuredContent: z.json().optional(),
	isError: z.boolean().optional(),
});
const protocolMessageSchema = z.object({
	id: z.union([z.string(), z.number(), z.null()]).optional(),
	method: z.string().optional(),
	params: z.json().optional(),
	result: z.json().optional(),
	error: z.object({ message: z.string().optional() }).catchall(z.json()).optional(),
}).catchall(z.json());
const threadStartSchema = z.object({ thread: z.object({ id: z.string() }) });

export type DirectBrokerElicitationRequest = z.infer<typeof elicitationRequestSchema>;

export interface DirectBrokerElicitationResponse {
	action: "accept" | "decline" | "cancel";
	content?: JsonValue;
	_meta?: JsonValue;
}

export interface DirectBrokerResult {
	content: JsonObject[];
	structuredContent?: JsonValue;
	isError: boolean;
	brokerVersion: string;
	clientBuild: string;
	elicitationRequests: number;
	modelTurnsStarted: 0;
	ephemeralThread: true;
	brokerCleanupVerified: boolean;
}

export interface DirectBrokerOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	onElicitation?: (
		request: DirectBrokerElicitationRequest,
	) => DirectBrokerElicitationResponse | Promise<DirectBrokerElicitationResponse>;
	supportsOpaqueFormElicitation?: boolean;
	appServerCommand?: string;
	appServerArgs?: string[];
	skipSignatureVerification?: boolean;
	processEnumeratorCommand?: string;
	cwdProcessEnumeratorCommand?: string;
	nativeClientPath?: string;
	computerUseAppPath?: string;
	onSpawn?: (pid: number) => void;
	configPath?: string;
}

class BrokerVerificationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BrokerVerificationError";
	}
}

export class UnifiedRuntimeUnavailableError extends BrokerVerificationError {
	constructor(message: string) {
		super(message);
		this.name = "UnifiedRuntimeUnavailableError";
	}
}

export class DirectBrokerCallError extends Error {
	readonly cleanupVerified: boolean;
	readonly directCalls: number;
	readonly modelTurnsStarted: number;
	readonly ephemeralThread: boolean;
	readonly elicitationRequests: number;
	readonly brokerVersion: string;
	readonly clientBuild: string;
	constructor(
		message: string,
		cleanupVerified: boolean,
		cause?: unknown,
		evidence: {
			directCalls?: number;
			modelTurnsStarted?: number;
			ephemeralThread?: boolean;
			elicitationRequests?: number;
			brokerVersion?: string;
			clientBuild?: string;
		} = {},
	) {
		super(message, { cause });
		this.name = "DirectBrokerCallError";
		this.cleanupVerified = cleanupVerified;
		this.directCalls = evidence.directCalls ?? 0;
		this.modelTurnsStarted = evidence.modelTurnsStarted ?? 0;
		this.ephemeralThread = evidence.ephemeralThread ?? false;
		this.elicitationRequests = evidence.elicitationRequests ?? 0;
		this.brokerVersion = evidence.brokerVersion ?? "unknown";
		this.clientBuild = evidence.clientBuild ?? "unknown";
	}
}

interface CommandResult {
	status: number | null;
	stdout?: string;
	stderr?: string;
}

type RunSync = (command: string, args: string[]) => CommandResult;

function productionRunSync(command: string, args: string[]): CommandResult {
	return spawnSync(command, args, { encoding: "utf8", timeout: VERIFY_COMMAND_TIMEOUT_MS });
}

function verifySignedBinary(binaryPath: string, runSync: RunSync): void {
	const name = path.basename(binaryPath);
	const verify = runSync("/usr/bin/codesign", ["--verify", "--strict", binaryPath]);
	if (verify.status === null) {
		throw new BrokerVerificationError(`Could not check the signature of ${name}: codesign did not finish within ${VERIFY_COMMAND_TIMEOUT_MS / 1000} seconds. The runtime app may be updating, or the Mac is busy. Wait a minute, then retry.`);
	}
	if (verify.status !== 0) {
		const reason = (verify.stderr ?? "").trim().split("\n")[0].slice(0, 300);
		throw new BrokerVerificationError(`Signature verification failed for ${name}${reason ? ` (${reason})` : ""}. If the runtime dependency is updating, wait for it to finish and retry. Otherwise reinstall the ChatGPT desktop app (https://chatgpt.com/download), which supplies the signed runtime.`);
	}
	const details = runSync("/usr/bin/codesign", ["-dv", "--verbose=2", binaryPath]);
	const output = `${details.stdout ?? ""}\n${details.stderr ?? ""}`;
	if (details.status !== 0 || !new RegExp(`(?:^|\\n)TeamIdentifier=${RUNTIME_SIGNING_TEAM_ID}(?:\\n|$)`).test(output)) {
		throw new BrokerVerificationError(`${path.basename(binaryPath)} is not signed by the expected Team ID (${RUNTIME_SIGNING_TEAM_ID})`);
	}
}

const pathConfigSchema = z.object({
	appServerPath: z.string().min(1).optional(),
	cuaReplConfigPath: z.string().min(1).optional(),
});

export type OfficialPathConfig = z.infer<typeof pathConfigSchema>;

export function pathConfigFile(stateRoot: string): string {
	return path.join(stateRoot, "config.json");
}

export function readOfficialPathConfig(configPath: string): OfficialPathConfig {
	if (!existsSync(configPath)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(configPath, "utf8"));
	} catch {
		throw new BrokerVerificationError(`Pi Computer Use config at ${configPath} is not valid JSON`);
	}
	const config = pathConfigSchema.safeParse(parsed);
	if (!config.success) {
		throw new BrokerVerificationError(`Pi Computer Use config at ${configPath} must set "appServerPath" and "cuaReplConfigPath", when present, to path strings`);
	}
	return config.data;
}

function notFoundError(component: string, checked: string[], key: keyof OfficialPathConfig, hint: string, configPath?: string, installedRuntimeApp?: string): BrokerVerificationError {
	const where = configPath ? `in ${configPath}` : "in config.json in the Pi Computer Use state directory";
	const moved = installedRuntimeApp ? ` The runtime app is installed at ${installedRuntimeApp}; if it is up to date, an update may have moved this file. ${outOfStepHint()}` : "";
	return new BrokerVerificationError(
		`${component} was not found. Checked: ${checked.join(", ")}. ${hint}${moved} If it is installed elsewhere, set "${key}" to its absolute path ${where}, or remove "${key}" to restore automatic discovery.`,
	);
}

function defaultRuntimeAppPaths(userHome = os.userInfo().homedir): string[] {
	return ["/Applications/ChatGPT.app", path.join(userHome, "Applications", "ChatGPT.app")];
}

function installedRuntimeAppPaths(defaultApps: string[], runSync: RunSync): string[] {
	const indexed = runSync("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == "${RUNTIME_APP_BUNDLE_ID}"`]);
	const indexedApps = indexed.status === 0 ? (indexed.stdout ?? "").split("\n").filter((line) => line.endsWith(".app")) : [];
	return [...new Set([...defaultApps, ...indexedApps])];
}

interface ResolveOfficialOptions {
	userHome?: string;
	runtimeAppPaths?: string[];
	configPath?: string;
	runSync?: RunSync;
}

function locateRuntimeAppServer(options: ResolveOfficialOptions = {}): string {
	const runSync = options.runSync ?? productionRunSync;
	const config = options.configPath ? readOfficialPathConfig(options.configPath) : {};
	const runtimeApps = config.appServerPath ? [] : installedRuntimeAppPaths(options.runtimeAppPaths ?? defaultRuntimeAppPaths(options.userHome), runSync);
	const candidates = config.appServerPath ? [path.resolve(config.appServerPath)]
		: runtimeApps.flatMap((app) => APP_SERVER_RELATIVE_PATHS.map((relative) => path.join(app, relative)));
	const found = candidates.find((candidate) => existsSync(candidate));
	if (!found) {
		throw notFoundError(
			"Computer Use runtime app-server",
			candidates,
			"appServerPath",
			"Install or update the ChatGPT macOS app (https://chatgpt.com/download), which provides the signed runtime, then open it.",
			options.configPath,
			runtimeApps.find((app) => existsSync(app)),
		);
	}
	return realpathSync(found);
}

export function resolveRuntimeAppServer(options: ResolveOfficialOptions = {}): string {
	const appServerPath = locateRuntimeAppServer(options);
	verifySignedBinary(appServerPath, options.runSync ?? productionRunSync);
	return appServerPath;
}

const cuaReplServerSchema = z.object({
	command: z.string().min(1),
	args: z.array(z.string()).default([]),
	env: z.record(z.string(), z.string()).default({}),
}).catchall(z.json());
const cuaReplConfigSchema = z.object({ mcpServers: z.object({ cua_repl: cuaReplServerSchema }) });

export type CuaReplServer = z.infer<typeof cuaReplServerSchema>;

export interface OfficialCuaRepl {
	configPath: string;
	server: CuaReplServer;
	nodeReplPath: string;
	computerUseAppPath: string;
	clientBuild: string;
}

function plistValue(appPath: string, key: string, runSync: RunSync): string | undefined {
	const result = runSync("/usr/bin/plutil", ["-extract", key, "raw", path.join(appPath, "Contents", "Info.plist")]);
	const value = (result.stdout ?? "").trim();
	return result.status === 0 && value ? value : undefined;
}

function verifiedExecutable(executable: string, runSync: RunSync): string {
	if (!existsSync(executable)) {
		throw new BrokerVerificationError(`${executable}, named by the Computer Use runtime config, does not exist. ${outOfStepHint()}`);
	}
	const canonical = realpathSync(executable);
	verifySignedBinary(canonical, runSync);
	return canonical;
}

interface CuaReplServerSource {
	configPath: string;
	server: CuaReplServer;
}

function readCuaReplServer(appServerPath: string, options: ResolveOfficialOptions): CuaReplServerSource {
	const runSync = options.runSync ?? productionRunSync;
	const config = options.configPath ? readOfficialPathConfig(options.configPath) : {};
	const userHome = options.userHome ?? os.userInfo().homedir;
	let configPath = config.cuaReplConfigPath ? path.resolve(config.cuaReplConfigPath) : undefined;
	if (!configPath) {
		const runtimeApp = /^(.*?\.app)\/Contents\/Resources\//.exec(appServerPath)?.[1];
		const version = runtimeApp ? plistValue(runtimeApp, "CFBundleShortVersionString", runSync) : undefined;
		if (!runtimeApp || !version) {
			throw new BrokerVerificationError(`Could not read the runtime app version for ${appServerPath}. Set "cuaReplConfigPath" to the unified-computer-use .mcp.json ${options.configPath ? `in ${options.configPath}` : "in config.json in the Pi Computer Use state directory"}.`);
		}
		configPath = path.join(userHome, CUA_REPL_CACHE_RELATIVE_PATH, version, ".mcp.json");
		if (!existsSync(configPath)) {
			throw new UnifiedRuntimeUnavailableError(`The runtime dependency (${version}) has not prepared its Computer Use runtime config (expected ${configPath}). Open the ChatGPT desktop app (\`open -a ChatGPT\`), wait for it to finish starting, then retry. If the file is still missing, run /reload in Pi or restart the MCP server to fall back to the legacy Computer Use tools.`);
		}
	}
	let server: CuaReplServer;
	try {
		server = cuaReplConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8"))).mcpServers.cua_repl;
	} catch (error) {
		if (!existsSync(configPath)) throw notFoundError("Computer Use runtime config", [configPath], "cuaReplConfigPath", "Open the ChatGPT desktop app so it can prepare the runtime dependency.", options.configPath);
		throw new BrokerVerificationError(`Computer Use runtime config at ${configPath} has an unexpected shape (${error instanceof Error ? error.message.split("\n")[0] : String(error)}). ${outOfStepHint()}`);
	}
	return { configPath, server };
}

export function readOfficialCuaReplServer(options: ResolveOfficialOptions = {}): CuaReplServer {
	return readCuaReplServer(locateRuntimeAppServer(options), options).server;
}

export function resolveOfficialCuaRepl(appServerPath: string, options: ResolveOfficialOptions = {}): OfficialCuaRepl {
	const runSync = options.runSync ?? productionRunSync;
	const userHome = options.userHome ?? os.userInfo().homedir;
	const { configPath, server } = readCuaReplServer(appServerPath, options);
	const nodeRepls = [server.command, ...server.args].filter((part) => path.isAbsolute(part) && path.basename(part) === "node_repl");
	if (nodeRepls.length !== 1) {
		throw new BrokerVerificationError(`Computer Use runtime config at ${configPath} does not name exactly one node_repl executable. ${outOfStepHint()}`);
	}
	const nodeReplPath = verifiedExecutable(nodeRepls[0]!, runSync);
	if (server.env.NODE_REPL_NODE_PATH) verifiedExecutable(server.env.NODE_REPL_NODE_PATH, runSync);
	const computerUseAppPath = server.env.SKY_CUA_SERVICE_PATH ?? path.join(userHome, ".codex", COMPUTER_USE_APP_RELATIVE_PATH);
	const servicePath = path.join(computerUseAppPath, SERVICE_RELATIVE_PATH);
	if (!existsSync(servicePath)) {
		throw notFoundError("Computer Use runtime service", [servicePath], "cuaReplConfigPath", "Open the ChatGPT desktop app and install its Computer Use runtime component.", options.configPath);
	}
	verifySignedBinary(realpathSync(servicePath), runSync);
	const clientBuild = plistValue(computerUseAppPath, "CFBundleVersion", runSync);
	if (!clientBuild) throw new BrokerVerificationError("Could not verify the Computer Use runtime build");
	return { configPath, server, nodeReplPath, computerUseAppPath, clientBuild };
}

export interface OfficialRuntimeSnapshot {
	configPath?: string;
	appServerPath: string;
	appServerDev: number;
	appServerIno: number;
	nodeReplPath: string;
	nodeReplDev: number;
	nodeReplIno: number;
	cuaReplConfigPath: string;
	computerUseAppPath: string;
	clientBuild: string;
}

export function captureOfficialRuntimeSnapshot(
	appServerPath: string,
	cuaRepl: Pick<OfficialCuaRepl, "configPath" | "nodeReplPath" | "computerUseAppPath" | "clientBuild">,
	configPath?: string,
): OfficialRuntimeSnapshot {
	const appServerStat = statSync(appServerPath);
	const nodeReplStat = statSync(cuaRepl.nodeReplPath);
	return {
		configPath,
		appServerPath,
		appServerDev: appServerStat.dev,
		appServerIno: appServerStat.ino,
		nodeReplPath: cuaRepl.nodeReplPath,
		nodeReplDev: nodeReplStat.dev,
		nodeReplIno: nodeReplStat.ino,
		cuaReplConfigPath: cuaRepl.configPath,
		computerUseAppPath: cuaRepl.computerUseAppPath,
		clientBuild: cuaRepl.clientBuild,
	};
}

export function isOfficialRuntimeCurrent(
	snapshot: OfficialRuntimeSnapshot,
	options: ResolveOfficialOptions = {},
): boolean {
	try {
		const resolveOptions = { ...options, configPath: options.configPath ?? snapshot.configPath };
		const runSync = resolveOptions.runSync ?? productionRunSync;
		const currentAppServerPath = locateRuntimeAppServer(resolveOptions);
		if (currentAppServerPath !== snapshot.appServerPath) return false;
		const appServerStat = statSync(currentAppServerPath);
		if (appServerStat.dev !== snapshot.appServerDev || appServerStat.ino !== snapshot.appServerIno) return false;
		const currentConfigPath = readCuaReplServer(currentAppServerPath, resolveOptions).configPath;
		if (currentConfigPath !== snapshot.cuaReplConfigPath) return false;
		const nodeReplStat = statSync(snapshot.nodeReplPath);
		if (nodeReplStat.dev !== snapshot.nodeReplDev || nodeReplStat.ino !== snapshot.nodeReplIno) return false;
		const currentBuild = plistValue(snapshot.computerUseAppPath, "CFBundleVersion", runSync);
		return currentBuild === snapshot.clientBuild;
	} catch {
		return false;
	}
}

export function verifyOfficialDirectBroker(options: ResolveOfficialOptions = {}) {
	const runSync = options.runSync ?? productionRunSync;
	const appServerPath = resolveRuntimeAppServer({ ...options, runSync });
	const version = runSync(appServerPath, ["--version"]);
	if (version.status !== 0 || !/^codex-cli\s+\d+\./.test((version.stdout ?? "").trim())) {
		throw new BrokerVerificationError("Could not verify the Computer Use runtime app-server version");
	}
	const cuaRepl = resolveOfficialCuaRepl(appServerPath, { ...options, runSync });
	return { brokerVersion: (version.stdout ?? "").trim(), clientBuild: cuaRepl.clientBuild, cuaRepl, appServerPath };
}

function buildBrokerEnv(runtimeHome: string, tempRoot: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		HOME: tempRoot,
		CODEX_HOME: runtimeHome,
		PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
		TMPDIR: tempRoot,
		NO_COLOR: "1",
		CLICOLOR: "0",
	};
	for (const key of ["USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "SHELL", "TERM"]) {
		if (process.env[key]) env[key] = process.env[key];
	}
	return env;
}

function normalizeBrokerError(error: Error, stderr: string): Error {
	return /authentication|bearer|token/i.test(`${error.message}\n${stderr}`)
		? new Error("Pi Computer Use broker reported an authentication failure", { cause: error })
		: error;
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

class ProcessEnumerationError extends Error {
	readonly partialPids: Set<number>;
	constructor(message: string, partialPids: Set<number>, cause?: unknown) {
		super(message, { cause });
		this.name = "ProcessEnumerationError";
		this.partialPids = new Set(partialPids);
	}
}

function collectDescendants(rootPid: number, processEnumeratorCommand = "/usr/bin/pgrep"): Set<number> {
	const descendants = new Set<number>();
	const queue = [rootPid];
	while (queue.length > 0) {
		if (descendants.size >= 256) {
			throw new ProcessEnumerationError("Official app-server process tree exceeded the cleanup bound", descendants);
		}
		const parent = queue.shift()!;
		const result = spawnSync(processEnumeratorCommand, ["-P", String(parent)], { encoding: "utf8", timeout: 2000 });
		if (
			result.error
			|| (result.status !== 0 && result.status !== 1)
			|| (result.status === 1 && (result.stderr ?? "").trim().length > 0)
		) {
			throw new ProcessEnumerationError("Could not enumerate the official app-server process tree", descendants, result.error);
		}
		for (const token of (result.stdout ?? "").trim().split(/\s+/)) {
			const child = Number(token);
			if (!Number.isSafeInteger(child) || child <= 1 || child === rootPid || descendants.has(child)) continue;
			descendants.add(child);
			queue.push(child);
		}
	}
	return descendants;
}

function collectProcessesWithCwd(workDir: string, command = "/usr/sbin/lsof"): Set<number> {
	const result = spawnSync(command, ["-a", "-d", "cwd", "+d", workDir, "-Fp"], {
		encoding: "utf8",
		timeout: 3000,
	});
	if (
		result.error
		|| (result.status !== 0 && result.status !== 1)
		|| (result.status === 1 && unexpectedLsofStderr(result.stderr ?? "", workDir, statSync(workDir).dev).length > 0)
	) {
		throw new ProcessEnumerationError("Could not enumerate processes owned by the private broker working directory", new Set(), result.error);
	}
	const pids = new Set<number>();
	for (const line of (result.stdout ?? "").split("\n")) {
		const match = line.match(/^p(\d+)$/);
		if (!match) continue;
		const pid = Number(match[1]);
		if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) pids.add(pid);
	}
	return pids;
}

async function terminateGroup(
	proc: ChildProcessWithoutNullStreams | undefined,
	workDir: string,
	processEnumeratorCommand = "/usr/bin/pgrep",
	cwdProcessEnumeratorCommand = "/usr/sbin/lsof",
): Promise<void> {
	const pid = proc?.pid;
	if (!pid) return;
	const descendants = new Set<number>();
	const rootWasAlive = processExists(pid);
	let cleanupError: Error | undefined;
	const enumerate = (): Set<number> => {
		const found = new Set<number>();
		try {
			for (const child of collectDescendants(pid, processEnumeratorCommand)) found.add(child);
		} catch (error) {
			if (error instanceof ProcessEnumerationError) {
				for (const child of error.partialPids) found.add(child);
			}
			cleanupError ??= error instanceof Error ? error : new Error(String(error));
		}
		try {
			for (const owned of collectProcessesWithCwd(workDir, cwdProcessEnumeratorCommand)) found.add(owned);
		} catch (error) {
			if (error instanceof ProcessEnumerationError) {
				for (const owned of error.partialPids) found.add(owned);
			}
			cleanupError ??= error instanceof Error ? error : new Error(String(error));
		}
		return found;
	};
	for (const child of enumerate()) descendants.add(child);

	let rootFrozen = false;
	try {
		process.kill(-pid, "SIGSTOP");
		rootFrozen = true;
	} catch {
		try {
			proc.kill("SIGSTOP");
			rootFrozen = processExists(pid);
		} catch {}
	}
	if (rootWasAlive && !rootFrozen) cleanupError ??= new Error("Could not freeze the Pi Computer Use app-server before cleanup");

	let stable = false;
	for (let pass = 0; pass < 16; pass += 1) {
		let added = false;
		for (const child of enumerate()) {
			if (!descendants.has(child)) {
				descendants.add(child);
				added = true;
			}
			try { process.kill(child, "SIGSTOP"); }
			catch { if (processExists(child)) cleanupError ??= new Error("Could not freeze an app-server-owned process"); }
		}
		if (!added && pass > 0) { stable = true; break; }
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	if (!stable) cleanupError ??= new Error("Pi Computer Use app-server process tree did not stabilize for cleanup");

	for (const child of descendants) {
		try { process.kill(child, "SIGKILL"); } catch {}
	}
	try { process.kill(-pid, "SIGKILL"); } catch { try { proc.kill("SIGKILL"); } catch {} }
	for (let pass = 0; pass < 2; pass += 1) {
		await new Promise((resolve) => setTimeout(resolve, 25));
		for (const owned of enumerate()) {
			descendants.add(owned);
			try { process.kill(owned, "SIGKILL"); } catch {}
		}
	}
	for (let elapsed = 0; elapsed < 1500; elapsed += 25) {
		if (!processExists(-pid) && [...descendants].every((child) => !processExists(child))) break;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	let cwdSurvivors = new Set<number>();
	try { cwdSurvivors = collectProcessesWithCwd(workDir, cwdProcessEnumeratorCommand); }
	catch (error) { cleanupError ??= error instanceof Error ? error : new Error(String(error)); }
	for (const survivor of cwdSurvivors) {
		try { process.kill(survivor, "SIGKILL"); } catch {}
	}
	if (processExists(-pid) || [...descendants, ...cwdSurvivors].some((child) => processExists(child))) {
		cleanupError ??= new Error("Pi Computer Use app-server process tree did not terminate");
	}
	if (cleanupError) throw cleanupError;
}

function toToml(value: JsonValue): string {
	if (value === null) throw new Error("TOML has no null value");
	if (Array.isArray(value)) return `[${value.map(toToml).join(", ")}]`;
	if (value instanceof Object) {
		const entries = Object.entries(value).filter((entry): entry is [string, JsonValue] => entry[1] !== undefined);
		return `{ ${entries.map(([key, item]) => `${JSON.stringify(key)} = ${toToml(item)}`).join(", ")} }`;
	}
	return JSON.stringify(value).replaceAll("\u007f", "\\u007F");
}

type RequestKind = "control" | "tool" | "turn-end" | "cleanup";

export interface OfficialCuaReplSession {
	call(
		tool: CuaReplTool,
		args: CuaReplArguments,
		options?: Pick<DirectBrokerOptions, "timeoutMs" | "signal" | "onElicitation">,
	): Promise<DirectBrokerResult>;
	endTurn(): Promise<void>;
	isCurrent?(): boolean;
	close(): Promise<void>;
}

export function buildCuaReplServerLaunchConfig(
	server: CuaReplServer,
	workDir: string,
	userHome = os.userInfo().homedir,
) {
	const launch = [server.command, ...server.args];
	const nodeRepl = launch.findIndex((part) => path.isAbsolute(part) && path.basename(part) === "node_repl");
	assert(nodeRepl >= 0, "cua_repl config must name a node_repl executable");
	return {
		...server,
		command: launch[nodeRepl]!,
		args: launch.slice(nodeRepl + 1).filter((arg) => arg !== "--require-browser-access"),
		env: { ...server.env, HOME: userHome },
		cwd: workDir,
		enabled: true,
	};
}

export async function createOfficialCuaReplSession(
	options: DirectBrokerOptions = {},
): Promise<OfficialCuaReplSession> {
	const verification = options.skipSignatureVerification
		? {
			brokerVersion: "test-app-server",
			clientBuild: "test-client",
			server: undefined,
			appServerPath: undefined,
			cuaReplConfigPath: undefined,
			computerUseAppPath: options.computerUseAppPath,
			nativeClientPath: options.nativeClientPath,
			runtimeSnapshot: undefined,
		}
		: (() => {
			const verified = verifyOfficialDirectBroker({ configPath: options.configPath });
			ensureChromeNativeHostManifest({
				cuaReplConfigPath: verified.cuaRepl.configPath,
				verifyBinary: (binaryPath) => verifySignedBinary(binaryPath, productionRunSync),
			});
			const candidateNativeClient = path.join(verified.cuaRepl.computerUseAppPath, NATIVE_CLIENT_RELATIVE_PATH);
			const nativeClientPath = existsSync(candidateNativeClient) ? realpathSync(candidateNativeClient) : undefined;
			if (nativeClientPath) verifySignedBinary(nativeClientPath, productionRunSync);
			return {
				...verified,
				server: verified.cuaRepl.server,
				cuaReplConfigPath: verified.cuaRepl.configPath,
				computerUseAppPath: verified.cuaRepl.computerUseAppPath,
				nativeClientPath,
				runtimeSnapshot: captureOfficialRuntimeSnapshot(verified.appServerPath, verified.cuaRepl, options.configPath),
			};
		})();
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-computer-use."));
	const runtimeHome = path.join(tempRoot, "runtime-home");
	const workDir = path.join(tempRoot, "work");
	await mkdir(runtimeHome, { mode: 0o700 });
	await mkdir(workDir, { mode: 0o700 });
	await writeFile(path.join(runtimeHome, "config.toml"), "", { mode: 0o600 });
	await chmod(runtimeHome, 0o700);

	let proc: ChildProcessWithoutNullStreams | undefined;
	let processClosed: Promise<void> | undefined;
	let termination: Promise<void> | undefined;
	let fatalError: Error | undefined;
	let stderr = "";
	let nextId = 1;
	let modelTurnsStarted = 0;
	let ephemeralThread = false;
	let threadId = "";
	let turnId = randomUUID();
	let turnActive = false;
	let cleanupRequestId: string | undefined;
	let toolResponse: { id: string; done: Promise<void>; finish(): void } | undefined;
	let closed = false;
	let closePromise: Promise<void> | undefined;
	let callActive = false;
	let currentElicitation: DirectBrokerOptions["onElicitation"];
	let currentElicitationCount = 0;
	const pending = new Map<string, { resolve(value: JsonValue): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
	const rejectAll = (error: Error): void => {
		for (const waiter of pending.values()) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
		pending.clear();
	};
	const ensureTerminated = (): Promise<void> => {
		termination ??= terminateGroup(proc, workDir, options.processEnumeratorCommand, options.cwdProcessEnumeratorCommand);
		return termination;
	};
	const fail = (error: Error): void => {
		fatalError ??= error;
		rejectAll(fatalError);
		void ensureTerminated().catch(() => undefined);
	};
	const cancel = (error: Error): void => {
		fatalError ??= error;
		rejectAll(fatalError);
		void close().catch(() => undefined);
	};
	const send = (message: JsonValue): void => {
		if (!proc?.stdin.writable) throw new Error("Pi Computer Use app-server stdin is unavailable");
		proc.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
	};
	const request = (methodName: string, params: JsonValue, timeoutMs: number, kind: RequestKind = "control"): Promise<JsonValue> => {
		const id = String(nextId++);
		if (kind === "cleanup") cleanupRequestId = id;
		if (kind === "tool") {
			let finish!: () => void;
			const done = new Promise<void>((resolve) => { finish = resolve; });
			toolResponse = { id, done, finish };
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				const recovery = kind === "tool"
					? `The target app may be unresponsive. ${STUCK_SERVICE_HINT}`
					: `Retry once. If it times out again: ${outOfStepHint(verification.brokerVersion)}`;
				const error = new Error(`Pi Computer Use app-server request timed out: ${methodName}. ${recovery}`);
				reject(error);
				if (kind === "tool") cancel(error);
				else if (kind === "control") fail(error);
			}, timeoutMs);
			pending.set(id, { resolve, reject, timer });
			try { send({ method: methodName, id, params }); }
			catch (error) {
				clearTimeout(timer);
				pending.delete(id);
				if (toolResponse?.id === id) { toolResponse.finish(); toolResponse = undefined; }
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	};
	const toolCall = (tool: string, args: JsonObject, timeoutMs: number, kind: RequestKind) => request("mcpServer/tool/call", {
		threadId, server: CUA_REPL_SERVER, tool, arguments: args,
		_meta: { "x-codex-turn-metadata": { thread_id: threadId, session_id: threadId, turn_id: turnId } },
	}, timeoutMs, kind);
	const drainToolResponse = (timeoutMs: number): Promise<boolean> => {
		if (!toolResponse) return Promise.resolve(true);
		const response = toolResponse;
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve(false), timeoutMs);
			void response.done.then(() => { clearTimeout(timer); resolve(true); });
		});
	};
	let turnCleanupHome: string | undefined;
	const resolveTurnCleanupHome = async (appPath: string): Promise<string> => {
		let componentHome = path.dirname(path.dirname(appPath));
		if (path.join(componentHome, COMPUTER_USE_APP_RELATIVE_PATH) !== appPath) {
			if (!turnCleanupHome) {
				turnCleanupHome = path.join(tempRoot, "turn-cleanup-home");
				await mkdir(path.join(turnCleanupHome, "computer-use"), { recursive: true, mode: 0o700 });
				await symlink(appPath, path.join(turnCleanupHome, COMPUTER_USE_APP_RELATIVE_PATH));
			}
			componentHome = turnCleanupHome;
		}
		return componentHome;
	};
	const sendTurnEnded = async (kind: "turn-end" | "cleanup"): Promise<void> => {
		if (!turnActive) return;
		turnActive = false;
		const endedTurnId = turnId;
		try {
			await toolCall("turn_ended", { hook_event_name: "Stop", session_id: threadId, turn_id: endedTurnId }, 3_000, kind);
		} catch {}
		const nativeClientPath = verification.nativeClientPath;
		if (nativeClientPath && threadId) {
			const payload = JSON.stringify({
				type: "agent-turn-complete",
				"thread-id": threadId,
				"turn-id": endedTurnId,
				cwd: workDir,
				"input-messages": [],
				"last-assistant-message": "",
			});
			try {
				const env: JsonObject = {};
				if (verification.computerUseAppPath) {
					env.CODEX_HOME = await resolveTurnCleanupHome(verification.computerUseAppPath);
				}
				await request("command/exec", {
					command: [nativeClientPath, "turn-ended", payload],
					cwd: workDir,
					env,
					sandboxPolicy: { type: "dangerFullAccess" },
					timeoutMs: 3_000,
				}, 5_000, kind);
			} catch {}
		}
		turnId = randomUUID();
	};

	const close = (): Promise<void> => {
		closePromise ??= (async () => {
			closed = true;
			rejectAll(new Error("Pi Computer Use app-server closed"));
			if (turnActive && !termination && proc?.stdin.writable && await drainToolResponse(1_000) && !termination) {
				await sendTurnEnded("cleanup");
			}
			let cleanupError: Error | undefined;
			try {
				await ensureTerminated();
				if (processClosed) {
					await new Promise<void>((resolve, reject) => {
						const timer = setTimeout(() => reject(new Error("Pi Computer Use app-server stdio did not close")), 1_000);
						processClosed!.then(() => { clearTimeout(timer); resolve(); });
					});
				}
				await new Promise<void>((resolve) => setImmediate(resolve));
				await rm(tempRoot, { recursive: true, force: true });
			} catch (error) {
				cleanupError = error instanceof Error ? error : new Error(String(error));
			}
			if (cleanupError) throw new Error("Pi Computer Use broker cleanup failed", { cause: cleanupError });
			if (fatalError || modelTurnsStarted !== 0) throw fatalError ?? new BrokerVerificationError("Model-turn activity was observed during broker teardown");
		})();
		return closePromise;
	};

	try {
		const command = options.appServerCommand ?? verification.appServerPath;
		if (!command) throw new BrokerVerificationError("The Computer Use runtime app-server was not verified");
		let commandArgs = options.appServerArgs;
		if (!commandArgs) {
			assert(verification.server && verification.appServerPath, "Test brokers must supply appServerArgs");
			const server = buildCuaReplServerLaunchConfig(verification.server, workDir);
			const mcpTable = toToml({ [CUA_REPL_SERVER]: server });
			const disabledProvider = '{ name = "Direct dispatch disabled provider", base_url = "http://127.0.0.1:9/v1", wire_api = "responses", request_max_retries = 0, stream_max_retries = 0, supports_websockets = false, requires_openai_auth = false }';
			commandArgs = [
				"-c", 'model_provider="direct_disabled"',
				"-c", 'model="direct-disabled"',
				"-c", `model_providers.direct_disabled=${disabledProvider}`,
				"-c", "features.shell_tool=false",
				"-c", "features.unified_exec=false",
				"-c", "features.multi_agent=false",
				"-c", "features.memories=false",
				"-c", "memories.use_memories=false",
				"-c", "memories.generate_memories=false",
				"-c", "features.remote_plugin=false",
				"-c", "features.plugins=false",
				"-c", "features.remote_control=false",
				"-c", "features.hooks=false",
				"-c", "analytics.enabled=false",
				"-c", 'otel.exporter="none"',
				"-c", 'web_search="disabled"',
				"-c", 'history.persistence="none"',
				"-c", `mcp_servers=${mcpTable}`,
				"-c", "plugins={}",
				"app-server", "--stdio",
			];
		}
		proc = spawn(command, commandArgs, {
			cwd: workDir,
			detached: true,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: buildBrokerEnv(runtimeHome, tempRoot),
		});
		const spawnedProcess = proc;
		processClosed = new Promise((resolve) => spawnedProcess.once("close", () => resolve()));
		if (proc.pid) options.onSpawn?.(proc.pid);
		proc.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") fail(error); });
		proc.stderr.setEncoding("utf8");
		proc.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-16_384); });
		proc.once("error", (error) => fail(error));
		proc.once("close", (code) => {
			if (pending.size === 0) return;
			const output = stderr.replace(ANSI_ESCAPE_PATTERN, "").trim().split("\n").slice(-6).join("\n").slice(-1_000);
			fail(new Error(`Pi Computer Use app-server exited before completing the request (${code ?? "unknown"})${output ? `. It reported:\n${output}\n` : ". "}${outOfStepHint(verification.brokerVersion)}`));
		});

		const processProtocolLine = (line: string): void => {
			let parsedMessage: ReturnType<typeof protocolMessageSchema.safeParse>;
			try { parsedMessage = protocolMessageSchema.safeParse(JSON.parse(line)); }
			catch { fail(new Error("Pi Computer Use app-server emitted malformed JSONL")); return; }
			if (!parsedMessage.success) { fail(new Error("Pi Computer Use app-server emitted an invalid protocol message")); return; }
			const message = parsedMessage.data;
			if (message.method?.startsWith("turn/") || message.method?.startsWith("item/")) {
				modelTurnsStarted += 1;
				fail(new Error("Pi Computer Use app-server unexpectedly emitted model-turn activity during direct dispatch"));
				return;
			}
			if (toolResponse?.id === String(message.id) && (message.result !== undefined || message.error !== undefined)) {
				toolResponse.finish();
				toolResponse = undefined;
			}
			if ((fatalError || closed) && String(message.id) !== cleanupRequestId) return;
			try {
				if (message.id != null && (message.result !== undefined || message.error !== undefined)) {
					const waiter = pending.get(String(message.id));
					if (!waiter) return;
					pending.delete(String(message.id));
					clearTimeout(waiter.timer);
					if (message.error) waiter.reject(new Error(`Pi Computer Use app-server error: ${message.error.message ?? "unknown"}. ${outOfStepHint(verification.brokerVersion)}`));
					else waiter.resolve(message.result ?? null);
					return;
				}
				if (message.id != null && message.method) {
					if (message.method !== "mcpServer/elicitation/request") {
						send({ id: message.id, error: { code: -32601, message: "Unsupported server request" } });
						return;
					}
					currentElicitationCount += 1;
					const requestParams = elicitationRequestSchema.parse(message.params ?? {});
					void (async () => {
						let response: DirectBrokerElicitationResponse = { action: "cancel" };
						try {
							if (currentElicitation) response = await currentElicitation(requestParams);
						} catch { response = { action: "cancel" }; }
						if (fatalError || closed || !proc?.stdin.writable) return;
						send({ id: message.id, result: { ...response } });
					})().catch((error) => fail(error instanceof Error ? error : new Error(String(error))));
				}
			} catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
		};
		const stdoutLines = createInterface({ input: proc.stdout, crlfDelay: Number.POSITIVE_INFINITY });
		stdoutLines.on("line", processProtocolLine);

		await request("initialize", {
			clientInfo: { name: "pi_computer_use", title: "Pi Computer Use", version: PACKAGE_VERSION },
			capabilities: { mcpServerOpenaiFormElicitation: options.supportsOpaqueFormElicitation === true },
		}, 15_000);
		send({ method: "initialized" });
		const started = threadStartSchema.parse(await request("thread/start", {
			cwd: workDir, approvalPolicy: "never", sandbox: "danger-full-access", ephemeral: true, serviceName: "pi_computer_use",
		}, 30_000));
		threadId = started.thread.id;
		ephemeralThread = true;
	} catch (error) {
		const primary = normalizeBrokerError(error instanceof Error ? error : new Error(String(error)), stderr);
		try { await close(); }
		catch (closeError) {
			const closeFailure = closeError instanceof Error ? closeError : new Error(String(closeError));
			if (closeFailure.message === "Pi Computer Use broker cleanup failed") {
				throw new DirectBrokerCallError(closeFailure.message, false, primary);
			}
		}
		throw new DirectBrokerCallError(primary.message, true, primary, { modelTurnsStarted, ephemeralThread, brokerVersion: verification.brokerVersion, clientBuild: verification.clientBuild });
	}

	return {
		async call(tool, args, callOptions = {}) {
			if (closed) throw new DirectBrokerCallError("Pi Computer Use session is closed", true);
			if (callActive) throw new DirectBrokerCallError("Pi Computer Use session does not allow concurrent calls", false);
			callActive = true;
			currentElicitation = callOptions.onElicitation;
			currentElicitationCount = 0;
			let directCalls = 0;
			let abortHandler: (() => void) | undefined;
			try {
				if (callOptions.signal) {
					abortHandler = () => cancel(new Error("Pi Computer Use request cancelled"));
					if (callOptions.signal.aborted) abortHandler();
					else callOptions.signal.addEventListener("abort", abortHandler, { once: true });
				}
				if (fatalError) throw fatalError;
				turnActive = true;
				const raw = await toolCall(tool, args, callOptions.timeoutMs ?? 120_000, "tool");
				directCalls = 1;
				if (modelTurnsStarted !== 0) throw new BrokerVerificationError("Model-turn activity was observed during direct dispatch");
				const result = directResultSchema.parse(raw);
				const sanitizedContent = stripConfirmationPolicyBlocks(result.content);
				const stuck = result.isError && sanitizedContent.some((block) => block.type === "text" && String(block.text ?? "").includes(STUCK_SERVICE_ERROR));
				return {
					content: stuck ? [...sanitizedContent, { type: "text", text: STUCK_SERVICE_HINT }] : sanitizedContent,
					structuredContent: result.structuredContent,
					isError: result.isError === true,
					brokerVersion: verification.brokerVersion,
					clientBuild: verification.clientBuild,
					elicitationRequests: currentElicitationCount,
					modelTurnsStarted: 0,
					ephemeralThread: true,
					brokerCleanupVerified: false,
				};
			} catch (error) {
				const primary = normalizeBrokerError(error instanceof Error ? error : new Error(String(error)), stderr);
				throw new DirectBrokerCallError(primary.message, false, primary, {
					directCalls, modelTurnsStarted, ephemeralThread, elicitationRequests: currentElicitationCount,
					brokerVersion: verification.brokerVersion, clientBuild: verification.clientBuild,
				});
			} finally {
				if (abortHandler && callOptions.signal) callOptions.signal.removeEventListener("abort", abortHandler);
				currentElicitation = undefined;
				callActive = false;
			}
		},
		async endTurn() {
			if (closed || fatalError || callActive) return;
			await sendTurnEnded("turn-end");
		},
		isCurrent() {
			return verification.runtimeSnapshot ? isOfficialRuntimeCurrent(verification.runtimeSnapshot) : true;
		},
		close,
	};
}

export async function callOfficialCuaRepl(
	tool: CuaReplTool,
	args: CuaReplArguments,
	options: DirectBrokerOptions = {},
): Promise<DirectBrokerResult> {
	let session: OfficialCuaReplSession | undefined;
	let result: DirectBrokerResult | undefined;
	let failure: unknown;
	try {
		session = await createOfficialCuaReplSession(options);
		result = await session.call(tool, args, options);
	} catch (error) {
		failure = error;
	}
	let cleanupVerified = failure instanceof DirectBrokerCallError ? failure.cleanupVerified : false;
	try {
		if (session) {
			await session.close();
			cleanupVerified = true;
		}
	} catch (cleanupError) {
		const closeFailure = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
		throw new DirectBrokerCallError(
			closeFailure.message,
			closeFailure.message !== "Pi Computer Use broker cleanup failed",
			closeFailure,
			failure instanceof DirectBrokerCallError ? failure : {},
		);
	}
	if (failure) {
		if (failure instanceof DirectBrokerCallError) {
			throw new DirectBrokerCallError(failure.message, cleanupVerified, failure, failure);
		}
		throw failure;
	}
	assert(result, "A successful Computer Use call returns a result");
	return { ...result, brokerCleanupVerified: true };
}
