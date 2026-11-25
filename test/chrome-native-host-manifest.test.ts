import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureChromeNativeHostManifest } from "../src/chrome-native-host-manifest.ts";
import { buildCuaReplServerLaunchConfig } from "../src/direct-broker.ts";

async function makeChromePlugin(userHome: string, version: string, arch = "arm64", metadata?: { extensionHostName?: string; extensionIds?: string[] }) {
	const versionDir = path.join(userHome, ".codex/plugins/cache/openai-bundled/chrome", version);
	const hostBinary = path.join(versionDir, "extension-host/macos", arch, "ChatGPT for Chrome");
	await mkdir(path.dirname(hostBinary), { recursive: true });
	await writeFile(hostBinary, "signed-host\n", { mode: 0o755 });
	if (metadata) {
		const scriptsDir = path.join(versionDir, "scripts");
		await mkdir(scriptsDir, { recursive: true });
		await writeFile(path.join(scriptsDir, "extension-ids.json"), JSON.stringify(metadata));
	}
	return realpathSync(hostBinary);
}

test("writes Chrome native host manifest matching ChatGPT's plugin version, stays idempotent, and refreshes on version updates", async () => {
	const root = realpathSync(await mkdtemp(path.join(os.tmpdir(), "chrome-manifest-test.")));
	try {
		const v1Binary = await makeChromePlugin(root, "26.1120.50957", "arm64", {
			extensionHostName: "com.openai.codexextension",
			extensionIds: ["hehggadaopoacecdllhhajmbjkdcmajg", "odlomjlbamekndcpllcnffbgeohgkmjh"],
		});
		const v1Config = path.join(root, ".codex/plugins/cache/openai-bundled/unified-computer-use/26.1120.50957/.mcp.json");
		const verified: string[] = [];

		const first = ensureChromeNativeHostManifest({
			cuaReplConfigPath: v1Config,
			userHome: root,
			arch: "arm64",
			verifyBinary: (binaryPath) => verified.push(binaryPath),
		});
		assert.ok(first);
		assert.equal(first.updated, true);
		assert.equal(first.hostBinaryPath, v1Binary);
		assert.deepEqual(verified, [v1Binary]);

		const manifest = JSON.parse(await readFile(first.manifestPath, "utf8"));
		assert.deepEqual(manifest, {
			allowed_origins: [
				"chrome-extension://hehggadaopoacecdllhhajmbjkdcmajg/",
				"chrome-extension://odlomjlbamekndcpllcnffbgeohgkmjh/",
			],
			description: "ChatGPT browser native messaging host",
			name: "com.openai.codexextension",
			path: v1Binary,
			type: "stdio",
		});

		const second = ensureChromeNativeHostManifest({
			cuaReplConfigPath: v1Config,
			userHome: root,
			arch: "arm64",
			verifyBinary: (binaryPath) => verified.push(binaryPath),
		});
		assert.ok(second);
		assert.equal(second.updated, false);

		const v2Binary = await makeChromePlugin(root, "26.1200.99999", "arm64");
		const v2Config = path.join(root, ".codex/plugins/cache/openai-bundled/unified-computer-use/26.1200.99999/.mcp.json");
		const refreshed = ensureChromeNativeHostManifest({
			cuaReplConfigPath: v2Config,
			userHome: root,
			arch: "arm64",
		});
		assert.ok(refreshed);
		assert.equal(refreshed.updated, true);
		assert.equal(refreshed.hostBinaryPath, v2Binary);
		const updatedManifest = JSON.parse(await readFile(refreshed.manifestPath, "utf8"));
		assert.equal(updatedManifest.path, v2Binary);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("fails closed when the Chrome native host binary fails signature verification and skips when absent", async () => {
	const root = realpathSync(await mkdtemp(path.join(os.tmpdir(), "chrome-manifest-verify.")));
	try {
		assert.equal(ensureChromeNativeHostManifest({ userHome: root, arch: "arm64" }), undefined);
		await makeChromePlugin(root, "26.1120.50957", "arm64");
		assert.throws(
			() => ensureChromeNativeHostManifest({
				userHome: root,
				arch: "arm64",
				verifyBinary: () => { throw new Error("wrong signing team"); },
			}),
			/wrong signing team/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("node_repl launch config drops --require-browser-access while preserving other arguments", () => {
	const config = buildCuaReplServerLaunchConfig({
		command: "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl",
		args: ["--require-browser-access", "--other-flag"],
		env: { CUA_REPL_ENABLED_SURFACES: "browser,computer" },
	}, "/tmp/work", "/Users/tester");
	assert.equal(config.command, "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl");
	assert.deepEqual(config.args, ["--other-flag"]);
	assert.equal(config.env.HOME, "/Users/tester");
	assert.equal(config.cwd, "/tmp/work");
});
