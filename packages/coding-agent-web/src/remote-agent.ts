/**
 * RemoteAgent: adapts the WebSocket RPC client to the Agent interface
 * expected by web-ui components.
 *
 * Maintains local AgentState by processing server events, and proxies
 * all mutations (prompt, abort, setModel, etc.) to the server.
 */

import type { AgentEvent, AgentMessage, AgentState, AgentTool, ThinkingLevel } from "@mariozechner/pi-agent-core";
import { getModel, type ImageContent, type Model, streamSimple } from "@mariozechner/pi-ai";
import type { WsRpcClient } from "./ws-rpc-client.js";

export interface RemoteAgentOptions {
	client: WsRpcClient;
}

/**
 * Duck-types the Agent interface from @mariozechner/pi-agent-core.
 *
 * The web-ui AgentInterface accesses session.state, session.subscribe(),
 * session.prompt(), session.abort(), session.setModel(), session.setThinkingLevel(),
 * session.streamFn, and session.getApiKey.
 */
export class RemoteAgent {
	private _state: AgentState = {
		systemPrompt: "",
		model: getModel("google", "gemini-2.5-flash-lite-preview-06-17"),
		thinkingLevel: "off",
		tools: [],
		messages: [],
		isStreaming: false,
		streamMessage: null,
		pendingToolCalls: new Set<string>(),
		error: undefined,
	};

	private listeners = new Set<(e: AgentEvent) => void>();
	private client: WsRpcClient;
	private unsubscribeEvent: (() => void) | null = null;

	/**
	 * Partial tool results from tool_execution_update events.
	 * Keyed by toolCallId. Used by tool renderers to show streaming output.
	 */
	public partialToolResults = new Map<string, any>();

	/**
	 * Whether the server is compacting context.
	 */
	public isCompacting = false;

	/**
	 * Retry state for UI display.
	 */
	public retryState: { attempt: number; maxAttempts: number; delayMs: number; errorMessage: string } | null = null;

	/** Required by AgentInterface but unused for remote agent (server handles streaming) */
	public streamFn = streamSimple;

	/** Required by AgentInterface but unused (server manages API keys) */
	public getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	constructor(options: RemoteAgentOptions) {
		this.client = options.client;
		this.unsubscribeEvent = this.client.onEvent((event) => {
			this.handleEvent(event as unknown as AgentEvent & Record<string, unknown>);
		});
	}

	get state(): AgentState {
		return this._state;
	}

	subscribe(fn: (e: AgentEvent) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	/**
	 * Fetch initial state from the server and populate local AgentState.
	 */
	async init(): Promise<void> {
		const stateResp = await this.client.send({ type: "get_state" });
		if (stateResp.success && stateResp.data) {
			const data = stateResp.data as any;
			if (data.model) {
				this._state.model = data.model;
			}
			if (data.thinkingLevel) {
				this._state.thinkingLevel = data.thinkingLevel;
			}
			this._state.isStreaming = data.isStreaming || false;
			this.isCompacting = data.isCompacting || false;
		}

		const msgsResp = await this.client.send({ type: "get_messages" });
		if (msgsResp.success && msgsResp.data) {
			const data = msgsResp.data as any;
			if (data.messages) {
				this._state.messages = data.messages;
			}
		}

		const modelsResp = await this.client.send({ type: "get_available_models" });
		if (modelsResp.success && modelsResp.data) {
			const data = modelsResp.data as any;
			if (data.models) {
				this._availableModels = data.models;
			}
		}
	}

	private _availableModels: Model<any>[] = [];

	get availableModels(): Model<any>[] {
		return this._availableModels;
	}

	// =========================================================================
	// Mutations (proxy to server)
	// =========================================================================

	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
		if (typeof input === "string") {
			await this.client.send({ type: "prompt", message: input, images });
		} else {
			// AgentMessage or AgentMessage[] - extract text content
			const msgs = Array.isArray(input) ? input : [input];
			for (const msg of msgs) {
				if (msg.role === "user" && typeof msg.content === "string") {
					await this.client.send({ type: "prompt", message: msg.content });
				} else if (msg.role === "user" && Array.isArray(msg.content)) {
					const textParts = msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text);
					const imgParts = msg.content.filter((c: any) => c.type === "image");
					await this.client.send({
						type: "prompt",
						message: textParts.join("\n"),
						images: imgParts.length > 0 ? imgParts : undefined,
					});
				}
			}
		}
	}

	async abort(): Promise<void> {
		await this.client.send({ type: "abort" });
	}

	async setModel(model: Model<any>): Promise<void> {
		const resp = await this.client.send({ type: "set_model", provider: model.provider, modelId: model.id });
		if (resp.success && resp.data) {
			this._state.model = resp.data as Model<any>;
		}
	}

	setThinkingLevel(level: ThinkingLevel): void {
		this.client.send({ type: "set_thinking_level", level });
		this._state.thinkingLevel = level;
	}

	setTools(_tools: AgentTool<any>[]): void {
		// Tools are managed server-side; no-op for remote agent
	}

	steer(message: AgentMessage): void {
		if (message.role === "user" && typeof message.content === "string") {
			this.client.send({ type: "steer", message: message.content });
		}
	}

	followUp(message: AgentMessage): void {
		if (message.role === "user" && typeof message.content === "string") {
			this.client.send({ type: "follow_up", message: message.content });
		}
	}

	async compact(customInstructions?: string): Promise<void> {
		await this.client.send({ type: "compact", customInstructions });
	}

	async newSession(): Promise<void> {
		const resp = await this.client.send({ type: "new_session" });
		if (resp.success) {
			this._state.messages = [];
			this._state.streamMessage = null;
			this._state.pendingToolCalls = new Set();
			this._state.isStreaming = false;
			this._state.error = undefined;
			this.partialToolResults.clear();
		}
	}

	async cycleModel(): Promise<void> {
		const resp = await this.client.send({ type: "cycle_model" });
		if (resp.success && resp.data) {
			const data = resp.data as any;
			if (data?.model) {
				this._state.model = data.model;
			}
			if (data?.thinkingLevel) {
				this._state.thinkingLevel = data.thinkingLevel;
			}
		}
	}

	dispose(): void {
		if (this.unsubscribeEvent) {
			this.unsubscribeEvent();
			this.unsubscribeEvent = null;
		}
	}

	// =========================================================================
	// Event handling
	// =========================================================================

	private handleEvent(event: AgentEvent & Record<string, unknown>): void {
		switch (event.type) {
			case "agent_start":
				this._state.isStreaming = true;
				this._state.error = undefined;
				this.partialToolResults.clear();
				break;

			case "agent_end": {
				this._state.isStreaming = false;
				this._state.streamMessage = null;
				this._state.pendingToolCalls = new Set();
				this.refreshMessages();
				break;
			}

			case "message_start":
				this._state.streamMessage = (event as any).message ?? null;
				break;

			case "message_update":
				this._state.streamMessage = (event as any).message ?? null;
				break;

			case "message_end": {
				const msg = (event as any).message;
				if (msg) {
					this._state.messages = [...this._state.messages, msg];
				}
				this._state.streamMessage = null;
				break;
			}

			case "turn_end": {
				const turnMsg = (event as any).message;
				if (turnMsg?.role === "assistant" && turnMsg.errorMessage) {
					this._state.error = turnMsg.errorMessage;
				}
				break;
			}

			case "tool_execution_start": {
				const s = new Set(this._state.pendingToolCalls);
				s.add((event as any).toolCallId);
				this._state.pendingToolCalls = s;
				break;
			}

			case "tool_execution_update": {
				const toolCallId = (event as any).toolCallId;
				const partialResult = (event as any).partialResult;
				if (toolCallId && partialResult) {
					this.partialToolResults.set(toolCallId, partialResult);
				}
				break;
			}

			case "tool_execution_end": {
				const s = new Set(this._state.pendingToolCalls);
				s.delete((event as any).toolCallId);
				this._state.pendingToolCalls = s;
				this.partialToolResults.delete((event as any).toolCallId);
				break;
			}

			default: {
				// Handle session-specific events
				const eventType = event.type as string;
				if (eventType === "auto_compaction_start") {
					this.isCompacting = true;
				} else if (eventType === "auto_compaction_end") {
					this.isCompacting = false;
				} else if (eventType === "auto_retry_start") {
					this.retryState = {
						attempt: (event as any).attempt,
						maxAttempts: (event as any).maxAttempts,
						delayMs: (event as any).delayMs,
						errorMessage: (event as any).errorMessage,
					};
				} else if (eventType === "auto_retry_end") {
					this.retryState = null;
				}
				break;
			}
		}

		// Emit to all listeners
		for (const listener of this.listeners) {
			listener(event as AgentEvent);
		}
	}

	private async refreshMessages(): Promise<void> {
		const resp = await this.client.send({ type: "get_messages" });
		if (resp.success && resp.data) {
			const data = resp.data as any;
			if (data.messages) {
				this._state.messages = data.messages;
			}
		}
	}
}
