import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	AUDIT_LOG_FILENAME,
	migrateLegacyStateRoot,
	resolvePiStateRoot,
	resolveStandaloneStateRoot,
	STATE_HOME_ENV_VAR,
} from "../src/state-root.ts";

test("migrates legacy standalone and Pi state directories and audit logs once and stays idempotent", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-cu-state-migration."));
	const previous = process.env[STATE_HOME_ENV_VAR];
	delete process.env[STATE_HOME_ENV_VAR];
	try {
		const legacyStandalone = path.join(root, ".direct-computer-use");
		await mkdir(path.join(legacyStandalone, "audit"), { recursive: true, mode: 0o700 });
		await writeFile(path.join(legacyStandalone, "config.json"), '{"appServerPath":"/tmp/a"}\n');
		await writeFile(path.join(legacyStandalone, "audit", "direct-computer-use.jsonl"), '{"runId":"1"}\n');

		const resolvedStandalone = resolveStandaloneStateRoot(root);
		assert.equal(resolvedStandalone, path.join(root, ".pi-computer-use"));
		await assert.rejects(access(legacyStandalone));
		assert.equal(await readFile(path.join(resolvedStandalone, "config.json"), "utf8"), '{"appServerPath":"/tmp/a"}\n');
		assert.equal(await readFile(path.join(resolvedStandalone, "audit", AUDIT_LOG_FILENAME), "utf8"), '{"runId":"1"}\n');
		assert.equal(migrateLegacyStateRoot(legacyStandalone, resolvedStandalone), false);

		const agentDir = path.join(root, "pi-agent");
		const legacyPi = path.join(agentDir, "direct-computer-use");
		await mkdir(path.join(legacyPi, "audit"), { recursive: true, mode: 0o700 });
		await writeFile(path.join(legacyPi, "audit", "direct-computer-use.jsonl"), '{"runId":"2"}\n');

		const resolvedPi = resolvePiStateRoot(agentDir);
		assert.equal(resolvedPi, path.join(agentDir, "computer-use"));
		await assert.rejects(access(legacyPi));
		assert.equal(await readFile(path.join(resolvedPi, "audit", AUDIT_LOG_FILENAME), "utf8"), '{"runId":"2"}\n');
		assert.equal(resolvePiStateRoot(agentDir), resolvedPi);
	} finally {
		if (previous === undefined) delete process.env[STATE_HOME_ENV_VAR];
		else process.env[STATE_HOME_ENV_VAR] = previous;
		await rm(root, { recursive: true, force: true });
	}
});

test("skips migration when target exists, when legacy is absent, or when legacy is a symlink", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-cu-state-skip."));
	try {
		const target = path.join(root, "target");
		const legacy = path.join(root, "legacy");
		assert.equal(migrateLegacyStateRoot(legacy, target), false);
		await assert.rejects(access(target));

		await mkdir(target, { recursive: true });
		await mkdir(legacy, { recursive: true });
		await writeFile(path.join(target, "marker"), "keep");
		await writeFile(path.join(legacy, "marker"), "old");
		assert.equal(migrateLegacyStateRoot(legacy, target), false);
		assert.equal(await readFile(path.join(target, "marker"), "utf8"), "keep");

		const symlinkLegacy = path.join(root, "symlink-legacy");
		const symlinkTarget = path.join(root, "symlink-target");
		await symlink(legacy, symlinkLegacy);
		assert.equal(migrateLegacyStateRoot(symlinkLegacy, symlinkTarget), false);
		await assert.rejects(access(symlinkTarget));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
