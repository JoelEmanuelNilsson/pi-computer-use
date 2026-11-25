import { existsSync, lstatSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const STATE_HOME_ENV_VAR = "PI_COMPUTER_USE_HOME";
export const AUDIT_LOG_FILENAME = "pi-computer-use.jsonl";

const LEGACY_AUDIT_LOG_FILENAME = "direct-computer-use.jsonl";

function isRealDirectory(targetPath: string): boolean {
	try {
		const info = lstatSync(targetPath);
		return !info.isSymbolicLink() && info.isDirectory();
	} catch {
		return false;
	}
}

function isRealFile(targetPath: string): boolean {
	try {
		const info = lstatSync(targetPath);
		return !info.isSymbolicLink() && info.isFile();
	} catch {
		return false;
	}
}

export function migrateLegacyStateRoot(legacyDir: string, targetDir: string): boolean {
	let migrated = false;
	if (!existsSync(targetDir) && isRealDirectory(legacyDir)) {
		mkdirSync(path.dirname(targetDir), { recursive: true });
		try {
			renameSync(legacyDir, targetDir);
			migrated = true;
		} catch (error) {
			if (!existsSync(targetDir)) throw error;
		}
	}
	const auditDir = path.join(targetDir, "audit");
	const legacyAuditPath = path.join(auditDir, LEGACY_AUDIT_LOG_FILENAME);
	const targetAuditPath = path.join(auditDir, AUDIT_LOG_FILENAME);
	if (isRealDirectory(auditDir) && !existsSync(targetAuditPath) && isRealFile(legacyAuditPath)) {
		try {
			renameSync(legacyAuditPath, targetAuditPath);
			migrated = true;
		} catch (error) {
			if (!existsSync(targetAuditPath)) throw error;
		}
	}
	return migrated;
}

export function resolveStandaloneStateRoot(userHome = homedir()): string {
	const override = process.env[STATE_HOME_ENV_VAR];
	if (override) return override;
	const targetDir = path.join(userHome, ".pi-computer-use");
	migrateLegacyStateRoot(path.join(userHome, ".direct-computer-use"), targetDir);
	return targetDir;
}

export function resolvePiStateRoot(agentDir: string): string {
	const override = process.env[STATE_HOME_ENV_VAR];
	if (override) return override;
	const targetDir = path.join(agentDir, "computer-use");
	migrateLegacyStateRoot(path.join(agentDir, "direct-computer-use"), targetDir);
	return targetDir;
}
