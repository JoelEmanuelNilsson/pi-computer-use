import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { callOfficialCuaRepl, readOfficialCuaReplServer } from "../src/direct-broker.ts";
import { cuaReplToolDefinitions, type JsonObject } from "../src/tools.ts";

test("official signed broker completes a real cua_repl call", async () => {
	const result = await callOfficialCuaRepl("js", {
		code: 'let app = await cua.getApp("Finder", { emit: false }); nodeRepl.write("ready:" + typeof app.getAXState);',
	});
	assert.equal(result.isError, false);
	assert.equal(result.brokerCleanupVerified, true);
	assert.equal(result.modelTurnsStarted, 0);
	assert.equal(result.ephemeralThread, true);
	assert.ok(result.content.some((block) => block.type === "text" && String(block.text).includes("ready:function")));
	assert.equal(result.content.some((block) => block.type === "text" && String(block.text).includes("# Computer Use Confirmations Policy")), false);
});

interface NormalizedInputSchema {
	type: string;
	properties: Record<string, JsonObject>;
	additionalProperties?: boolean;
	required?: string[];
}

function stripSchemaDescriptions(schema: NormalizedInputSchema): NormalizedInputSchema {
	const properties: Record<string, JsonObject> = {};
	for (const [key, value] of Object.entries(schema.properties)) {
		const { description: _desc, ...rest } = value;
		properties[key] = rest;
	}
	const normalized: NormalizedInputSchema = {
		type: schema.type,
		properties,
		additionalProperties: schema.additionalProperties,
	};
	if (schema.required) normalized.required = schema.required;
	return normalized;
}

test("the advertised tool schemas match official node_repl with concise descriptions", async () => {
	const server = readOfficialCuaReplServer();
	const client = new Client({ name: "definition-check", version: "1.0.0" });
	// Listing tools needs no Computer Use service, so node_repl can run without its signed parent here.
	await client.connect(new StdioClientTransport({
		command: server.command,
		args: server.args,
		env: { ...server.env, HOME: os.userInfo().homedir, PATH: "/usr/bin:/bin" },
		stderr: "ignore",
	}));
	try {
		const listed = (await client.listTools()).tools;
		const ours = cuaReplToolDefinitions(server.env);
		assert.equal(client.getInstructions(), ours.instructions);
		for (const definition of ours.tools) {
			const official = listed.find((tool) => tool.name === definition.name);
			assert.ok(official, definition.name);
			assert.deepEqual(official.annotations, definition.annotations);
			const { oneOf: _oneOf, ...officialInputSchema } = official.inputSchema;
			assert.deepEqual(
				// SAFETY: MCP SDK tool inputSchema is a JSON Schema object with optional properties/required.
				stripSchemaDescriptions(officialInputSchema as any),
				// SAFETY: CuaReplToolDefinition inputSchema is a JSON Schema object.
				stripSchemaDescriptions(definition.inputSchema as any),
			);
			assert.ok(definition.description.length < (official.description ?? "").length, definition.name);
			assert.equal(definition.description.includes("::browser-complete"), false);
		}
	} finally {
		await client.close();
	}
});
