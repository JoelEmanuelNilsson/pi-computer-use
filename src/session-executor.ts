import {
	createOfficialCuaReplSession,
	pathConfigFile,
	STUCK_SERVICE_ERROR,
	type OfficialCuaReplSession,
} from "./direct-broker.ts";
import {
	defaultStateRoot,
	executeDirectTool,
	type DirectResponse,
	type DirectServiceDependencies,
} from "./direct-service.ts";
import type { CuaReplArguments, CuaReplTool } from "./tools.ts";

interface DirectSessionExecutorDependencies {
	createSession?: typeof createOfficialCuaReplSession;
	idleTurnEndMs?: number;
}

export class DirectSessionExecutor {
	private queue = Promise.resolve();
	private session?: OfficialCuaReplSession;
	private idleTimer?: NodeJS.Timeout;
	private readonly dependencies: DirectSessionExecutorDependencies;

	constructor(dependencies: DirectSessionExecutorDependencies = {}) {
		this.dependencies = dependencies;
	}

	private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation);
		this.queue = result.then(() => undefined, () => undefined);
		return result;
	}

	private clearIdleTimer(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
	}

	private async closeSession(): Promise<void> {
		this.clearIdleTimer();
		const session = this.session;
		this.session = undefined;
		await session?.close();
	}

	async execute(
		tool: CuaReplTool,
		params: CuaReplArguments,
		dependencies: DirectServiceDependencies,
	): Promise<DirectResponse> {
		return this.runExclusive(async () => {
			this.clearIdleTimer();
			try {
				const response = await executeDirectTool({ tool, arguments: params }, {
					...dependencies,
					callTool: async (directTool, args, options) => {
						if (this.session?.isCurrent && !this.session.isCurrent()) {
							await this.closeSession().catch(() => undefined);
						}
						if (directTool === "js_reset") await this.session?.endTurn();
						this.session ??= await (this.dependencies.createSession ?? createOfficialCuaReplSession)({
							supportsOpaqueFormElicitation: dependencies.supportsOpaqueFormElicitation === true,
							configPath: pathConfigFile(dependencies.stateRoot ?? defaultStateRoot()),
						});
						return this.session.call(directTool, args, options);
					},
				});
				const nativePipeFailed = response.content.some(
					(block) => block.type === "text" && String(block.text ?? "").includes(STUCK_SERVICE_ERROR),
				);
				if (nativePipeFailed) {
					await this.closeSession().catch(() => undefined);
				} else if (this.dependencies.idleTurnEndMs) {
					const timer = setTimeout(() => {
						void this.runExclusive(async () => {
							if (this.idleTimer === timer) await this.session?.endTurn();
						}).catch(() => undefined);
					}, this.dependencies.idleTurnEndMs);
					this.idleTimer = timer;
					timer.unref();
				}
				return response;
			} catch (error) {
				await this.closeSession().catch(() => undefined);
				throw error;
			}
		});
	}

	async endTurn(): Promise<void> {
		await this.runExclusive(async () => {
			this.clearIdleTimer();
			await this.session?.endTurn();
		});
	}

	async close(): Promise<void> {
		await this.runExclusive(() => this.closeSession());
	}
}
