import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JsonObject } from "./tools.ts";

const CONFIRMATION_POLICY_PATTERN = /(?:^|\n)# Computer Use Confirmations Policy\b[\s\S]*?(?=\n# [^\n#]|$)/g;
const BROWSER_SAFETY_PATTERN = /(?:^|\n)# Browser Safety\b[\s\S]*?(?=\n# [^\n#]|$)/g;

const DEFAULT_MAX_RESULT_BYTES = 50 * 1024;
const DEFAULT_MAX_RESULT_LINES = 2_000;

export function stripConfirmationPolicyText(text: string): string {
	return text
		.replace(CONFIRMATION_POLICY_PATTERN, "")
		.replace(BROWSER_SAFETY_PATTERN, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function stripConfirmationPolicyBlocks(content: JsonObject[]): JsonObject[] {
	const cleaned: JsonObject[] = [];
	for (const block of content) {
		if (block.type !== "text") {
			cleaned.push(block);
			continue;
		}
		const raw = String(block.text ?? "");
		const stripped = stripConfirmationPolicyText(raw);
		if (stripped.length === 0 && raw.trim().length > 0) continue;
		cleaned.push({ ...block, text: stripped.length === raw.length ? raw : stripped });
	}
	return cleaned;
}

export interface SpillOptions {
	maxBytes?: number;
	maxLines?: number;
}

export interface SpillResult {
	content: JsonObject[];
	fullOutputPath?: string;
}

export async function spillOversizedTextBlocks(
	content: JsonObject[],
	options: SpillOptions = {},
): Promise<SpillResult> {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_RESULT_BYTES;
	const maxLines = options.maxLines ?? DEFAULT_MAX_RESULT_LINES;
	const textBlocks = content.filter((block) => block.type === "text").map((block) => String(block.text ?? ""));
	const fullText = textBlocks.join("\n\n");
	const totalBytes = Buffer.byteLength(fullText, "utf8");
	const lines = fullText.split("\n");
	if (totalBytes <= maxBytes && lines.length <= maxLines) {
		return { content };
	}

	const keptLines: string[] = [];
	let keptBytes = 0;
	for (const line of lines) {
		if (keptLines.length >= maxLines) break;
		const lineBytes = Buffer.byteLength(keptLines.length > 0 ? `\n${line}` : line, "utf8");
		if (keptBytes + lineBytes > maxBytes) break;
		keptLines.push(line);
		keptBytes += lineBytes;
	}
	const keptText = keptLines.join("\n");
	const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-computer-use-output-"));
	const fullOutputPath = path.join(tempDir, "output.txt");
	await writeFile(fullOutputPath, fullText, { encoding: "utf8", mode: 0o600 });
	const notice = `\n\n[Pi Computer Use output truncated: showing ${keptLines.length} of ${lines.length} lines (${keptBytes} of ${totalBytes} bytes). Full output saved to: ${fullOutputPath}]`;

	const result: JsonObject[] = [];
	let textIndex = 0;
	let textOffset = 0;
	let noticeAdded = false;
	for (const block of content) {
		if (block.type !== "text") {
			result.push(block);
			continue;
		}
		const blockText = String(block.text ?? "");
		const start = textOffset + (textIndex > 0 ? 2 : 0);
		const end = start + blockText.length;
		const retained = keptText.length > start
			? blockText.slice(0, Math.min(end, keptText.length) - start)
			: "";
		const cutoffHere: boolean = !noticeAdded && keptText.length < end;
		if (retained || cutoffHere) {
			result.push({ ...block, text: `${retained}${cutoffHere ? notice : ""}` });
			noticeAdded ||= cutoffHere;
		}
		textOffset = end;
		textIndex += 1;
	}
	return { content: result, fullOutputPath };
}
