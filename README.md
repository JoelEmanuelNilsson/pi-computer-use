# Pi Computer Use

Pi Computer Use gives Pi and MCP clients native macOS desktop and Google Chrome automation through persistent JavaScript `cua_repl` sessions. The calling agent writes every script. This package runs no nested model and generates no action plan.

## Requirements

- macOS with an unlocked user session
- Node.js 22 or newer
- Pi 0.99.0 or newer when using the Pi integration
- The signed macOS runtime dependency supplied by the ChatGPT macOS app, installed by default at `/Applications/ChatGPT.app`, opened at least once since its last update so it writes its runtime config, with its Computer Use component under `~/.codex/computer-use/`

macOS Screen Recording, Accessibility, and TCC permissions still apply.

## Pi integration

Install from a local checkout or package source, then run `/reload` in Pi after updates.

```bash
npm ci
npm run build
pi -ne -e /absolute/path/to/computer-use/integrations/pi/index.ts
```

The extension registers two deferred Pi tools:

- `cua_repl` runs JavaScript in a persistent session with a `cua` object for native macOS apps and Google Chrome tabs.
- `cua_repl_reset` discards JavaScript bindings in the session without closing apps or browser tabs.

An agent starts by calling one entry point, such as:

```js
let app = await cua.getApp("TextEdit");
```

The first result includes the API reference and the app's accessibility tree. Later calls reuse the binding:

```js
await app.click(7);
await app.typeText("hello");
await app.getAXState();
```

Bindings persist across tool calls and turns until `cua_repl_reset`, a transport failure, or session shutdown. When the agent settles, the extension sends `turn_ended` so the background service clears its cursor and stops screen capture.

For Chrome automation, `cua.listTabs()` lists open tabs and `cua.createBrowserTab("chrome", url, { sessionName })` opens a new tab. The adapter starts `node_repl` directly without `--require-browser-access` and keeps Chrome's `com.openai.codexextension.json` native messaging host manifest pointed at the verified plugin host binary.

Pi truncates oversized text output at 50KB or 2,000 lines and writes the complete text to a mode-0600 file in a private `/tmp` directory. Images return directly and never spill to disk.

Run `/computer-use-status` in Pi to inspect the active route, verified paths, and any configuration error.

### Legacy fallback (deprecated)

If the installed runtime dependency has not written its unified `cua_repl` config, the extension falls back to ten deprecated typed tools (`computer_use_<method>` codemode tools in Pi and `<method>` tools over MCP). Status reports `"route": "legacy"` and the reason. Browser automation requires the unified `cua_repl` route. Run `/reload` in Pi or restart the MCP server once the unified runtime config is present.

## MCP server

Running `pi-computer-use` starts a stdio MCP server exposing `js`, `js_reset`, and `computer_use_status`:

```bash
npx pi-computer-use
pi-computer-use --status
```

Example MCP configuration:

```json
{
	"mcpServers": {
		"computer-use": {
			"command": "npx",
			"args": ["pi-computer-use"],
			"lifecycle": "lazy",
			"requestTimeoutMs": 180000,
			"directTools": false
		}
	}
}
```

MCP has no turn boundary, so the server sends `turn_ended` after one minute without calls while keeping the session alive until disconnect.

## Architecture and paths

Each session starts the signed runtime app-server with an isolated, credential-free home and launches `node_repl` with the settings from `~/.codex/plugins/cache/openai-bundled/unified-computer-use/<version>/.mcp.json`. The adapter isolates the app-server working directory and `CODEX_HOME`, passes the account's real `HOME` to `node_repl` so it can reach the background service, rejects any model-turn activity, verifies code signatures against Team ID `2DC432GLL2`, forwards elicitations, and cleans up its private process tree on teardown.

Audit records store bounded metadata without code, arguments, app content, screenshots, prompts, or credentials.

- Pi state directory: `~/.pi/agent/computer-use`
- Standalone MCP and CLI state directory: `~/.pi-computer-use`
- Audit log: `<stateDir>/audit/pi-computer-use.jsonl`
- Override variable: `PI_COMPUTER_USE_HOME`

Existing state in `direct-computer-use` or `.direct-computer-use` moves automatically on first use when the new directory does not yet exist.

### Runtime discovery and overrides

By default, the adapter checks `/Applications/ChatGPT.app`, `~/Applications/ChatGPT.app`, and any bundle Spotlight indexes under `com.openai.codex`. Inside the bundle it checks `Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex` and then `Contents/Resources/codex`. It never uses an arbitrary binary from `PATH` or `CODEX_CLI_PATH`.

To override discovered paths, create `config.json` in the state directory:

```json
{
	"appServerPath": "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
	"cuaReplConfigPath": "/Users/me/.codex/plugins/cache/openai-bundled/unified-computer-use/26.1120.50957/.mcp.json"
}
```

Configured binaries must still pass signature and Team ID verification. Explicit overrides never fall back silently to another installation.

### Targeting restricted apps

By default the background service blocks operating `com.openai.codex`. You can lift that restriction system-wide with:

```bash
defaults write -g ComputerUseAllowForbiddenTargets -bool YES
```

Run `defaults delete -g ComputerUseAllowForbiddenTargets` to restore the default.

### Failures and recovery

| Cause | Reported message and recovery |
| --- | --- |
| Background service is stuck | `Sky Computer Use native pipe startup failed` or a tool-call timeout. Run `pkill -f MacOS/SkyComputerUseService` so it relaunches on the next call. If it fails again, relaunch the ChatGPT desktop app. |
| Unified runtime config is missing | `The runtime dependency (<version>) has not prepared its Computer Use runtime config`. Run `open -a ChatGPT`, wait for startup, and retry. If still missing, run `/reload` in Pi or restart the MCP server to use legacy tools. |
| Signature check timed out | `codesign did not finish within 30 seconds`. Wait for updates or system load to settle and retry. |
| Signature verification failed | `Signature verification failed for …` with the `codesign` reason. Wait for updates to finish or reinstall the ChatGPT desktop app. |
| Package and runtime are out of step | App-server error or stderr tail with both versions. Run `open -a ChatGPT` to update the runtime, update `pi-computer-use`, and restart Pi or the MCP client. |
| Runtime dependency is not installed | Lists checked paths and the exact `config.json` path to edit. |

## Development

```bash
npm ci
npm run check
npm run check:pi
npm test
npm run build
```

## License

MIT. See [LICENSE](LICENSE).

This project began as a fork of `tmustier/codex-computer-use-mcp`.
