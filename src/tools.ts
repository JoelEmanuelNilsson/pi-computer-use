import { z } from "zod";

type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
	[key: string]: JsonValue | undefined;
}

export const CUA_REPL_TOOLS = ["js", "js_reset"] as const;
export type CuaReplTool = typeof CUA_REPL_TOOLS[number];
export type CuaReplArguments = JsonObject;

const cuaReplToolSchema = z.enum(CUA_REPL_TOOLS);

export function isCuaReplTool(value: string): value is CuaReplTool {
	return cuaReplToolSchema.safeParse(value).success;
}

interface JsProperties {
	code: JsonObject;
	completion_summary?: JsonObject;
	timeout_ms: JsonObject;
	title: JsonObject;
}

export interface CuaReplToolDefinition {
	name: CuaReplTool;
	description: string;
	inputSchema: {
		type: "object";
		properties: Partial<JsProperties>;
		required?: string[];
		additionalProperties: false;
	};
	annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
}

export interface CuaReplToolSet {
	instructions?: string;
	tools: CuaReplToolDefinition[];
}

const overridesSchema = z.object({ server_instructions: z.string().optional() });
const completionSchema = z.object({ instructions: z.string(), description: z.string() });

const TIMEOUT_DESCRIPTION = "Optional timeout in milliseconds (default 30000).";
const CODE_DESCRIPTION = "JavaScript to execute in the persistent cua_repl session.";
const TITLE_DESCRIPTION = "Short description of what this code block does.";
const JS_DESCRIPTION = [
	"Control native macOS apps and Google Chrome browser tabs with JavaScript (cua_repl).",
	"",
	"On the first call or after reset, run exactly one entry point below (optionally assigning it to a variable) with no other calls. The tool result returns the full API reference and initial UI state.",
	"",
	"- Apps, browsers, and tabs inventory: `await cua.getState();`",
	"- Open or target a macOS app by name, bundle ID, or path: `let app = await cua.getApp(\"TextEdit\");`",
	"- List open Chrome tabs: `await cua.listTabs();`",
	"- Bind an existing Chrome tab by ID or URL: `let tab = await cua.getTab(tabId, { browser: \"chrome\" });` or `let tab = await cua.getTab({ url }, { browser: \"chrome\" });`",
	"- Open a new Chrome tab: `let tab = await cua.createBrowserTab(\"chrome\", url);`",
	"",
	"Use `nodeRepl.write(value)` for extra text and `await nodeRepl.emitImage(image)` for images. The calls above, `getAXState()`, and `getScreenshot()` emit output automatically; do not wrap them in `write` or `emitImage`. Call `await cua.rewriteDocumentation()` if context was summarized.",
].join("\n");
const JS_RESET_DESCRIPTION = "Reset the persistent cua_repl JavaScript session. Discards JavaScript bindings without closing apps or browser tabs.";
const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

export function cuaReplToolDefinitions(env: Record<string, string>): CuaReplToolSet {
	const overrides = env.NODE_REPL_TOOL_OVERRIDES ? overridesSchema.parse(JSON.parse(env.NODE_REPL_TOOL_OVERRIDES)) : undefined;
	const completion = env.NODE_REPL_JS_COMPLETION_SUMMARY ? completionSchema.parse(JSON.parse(env.NODE_REPL_JS_COMPLETION_SUMMARY)) : undefined;
	const properties: JsProperties = {
		code: { description: CODE_DESCRIPTION, type: "string" },
		timeout_ms: { description: TIMEOUT_DESCRIPTION, minimum: 1, type: "integer" },
		title: { description: TITLE_DESCRIPTION, maxLength: 80, minLength: 1, type: "string" },
	};
	if (completion) properties.completion_summary = { description: completion.description, maxLength: 80, minLength: 1, type: "string" };
	const jsInputSchema: CuaReplToolDefinition["inputSchema"] = {
		type: "object",
		properties,
		additionalProperties: false,
	};
	if (!completion) jsInputSchema.required = ["code"];
	return {
		instructions: overrides?.server_instructions,
		tools: [
			{
				name: "js",
				description: completion ? `${JS_DESCRIPTION}\n\n${completion.instructions}` : JS_DESCRIPTION,
				inputSchema: jsInputSchema,
				annotations: ANNOTATIONS,
			},
			{
				name: "js_reset",
				description: JS_RESET_DESCRIPTION,
				inputSchema: { type: "object", properties: {}, additionalProperties: false },
				annotations: ANNOTATIONS,
			},
		],
	};
}
