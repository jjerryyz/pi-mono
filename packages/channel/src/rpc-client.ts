import { type ChildProcess, spawn } from "node:child_process";

interface RpcSuccessResponse<T = undefined> {
	id?: string;
	type: "response";
	command: string;
	success: true;
	data?: T;
}

interface RpcErrorResponse {
	id?: string;
	type: "response";
	command: string;
	success: false;
	error: string;
}

type RpcResponse<T = undefined> = RpcSuccessResponse<T> | RpcErrorResponse;

interface RpcEvent {
	type: string;
	[key: string]: unknown;
}

interface PendingRequest {
	resolve: (response: RpcResponse<unknown>) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

type RpcCommandBody =
	| { type: "prompt"; message: string }
	| { type: "set_session_name"; name: string }
	| { type: "get_last_assistant_text" };
type RpcCommand = { id?: string } & RpcCommandBody;

export interface PromptResult {
	assistantText: string | null;
	successfulToolNames: string[];
}

export interface PiRpcClientOptions {
	cliPath: string;
	cwd: string;
	args: string[];
	env?: Record<string, string>;
	provider?: string;
	model?: string;
}

export class PiRpcClient {
	private process: ChildProcess | null = null;
	private stderr = "";
	private requestId = 0;
	private buffer = "";
	private readonly pendingRequests = new Map<string, PendingRequest>();
	private readonly eventListeners: Array<(event: RpcEvent) => void> = [];

	constructor(private readonly options: PiRpcClientOptions) {}

	async start(): Promise<void> {
		if (this.process) {
			throw new Error("RPC client already started.");
		}

		const args = ["--mode", "rpc"];
		if (this.options.provider) {
			args.push("--provider", this.options.provider);
		}
		if (this.options.model) {
			args.push("--model", this.options.model);
		}
		args.push(...this.options.args);

		this.process = spawn("node", [this.options.cliPath, ...args], {
			cwd: this.options.cwd,
			env: {
				...process.env,
				...this.options.env,
			},
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.process.stderr?.on("data", (chunk: Buffer | string) => {
			this.stderr += chunk.toString();
		});
		this.process.stdout?.on("data", (chunk: Buffer | string) => {
			this.handleStdout(chunk.toString());
		});

		await new Promise((resolve) => setTimeout(resolve, 100));
		if (this.process.exitCode !== null) {
			throw new Error(`pi RPC process exited immediately with code ${this.process.exitCode}. ${this.stderr}`.trim());
		}
	}

	async stop(): Promise<void> {
		if (!this.process) {
			return;
		}

		for (const pending of this.pendingRequests.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("RPC client stopped."));
		}
		this.pendingRequests.clear();

		this.process.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				this.process?.kill("SIGKILL");
				resolve();
			}, 1000);

			this.process?.once("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
		});
		this.process = null;
	}

	onEvent(listener: (event: RpcEvent) => void): () => void {
		this.eventListeners.push(listener);
		return () => {
			const index = this.eventListeners.indexOf(listener);
			if (index >= 0) {
				this.eventListeners.splice(index, 1);
			}
		};
	}

	async promptAndWait(message: string, timeout = 180000): Promise<PromptResult> {
		const successfulToolNames = new Set<string>();
		let assistantText: string | null = null;
		let sawAssistantMessage = false;

		const waitForEnd = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timed out waiting for agent_end. ${this.stderr}`.trim()));
			}, timeout);

			const unsubscribe = this.onEvent((event) => {
				if (event.type === "message_end") {
					const eventAssistantText = extractAssistantText(event.message);
					if (eventAssistantText !== null) {
						sawAssistantMessage = true;
						assistantText = eventAssistantText;
					}
				}
				if (event.type === "tool_execution_end" && typeof event.toolName === "string" && event.isError === false) {
					successfulToolNames.add(event.toolName);
				}
				if (event.type === "agent_end") {
					clearTimeout(timer);
					unsubscribe();
					resolve();
				}
			});
		});

		await this.send({ type: "prompt", message });
		await waitForEnd;
		if (assistantText === null && sawAssistantMessage) {
			assistantText = await this.getLastAssistantText();
		}
		return {
			assistantText,
			successfulToolNames: Array.from(successfulToolNames),
		};
	}

	async setSessionName(name: string): Promise<void> {
		await this.send({ type: "set_session_name", name });
	}

	async getLastAssistantText(): Promise<string | null> {
		const response = await this.send({ type: "get_last_assistant_text" });
		return getResponseData<{ text: string | null }>(response).text;
	}

	private handleStdout(chunk: string): void {
		this.buffer += chunk;
		let newlineIndex = this.buffer.indexOf("\n");
		while (newlineIndex >= 0) {
			const line = this.buffer.slice(0, newlineIndex);
			this.buffer = this.buffer.slice(newlineIndex + 1);
			this.handleLine(line);
			newlineIndex = this.buffer.indexOf("\n");
		}
	}

	private handleLine(line: string): void {
		if (!line.trim()) {
			return;
		}

		let payload: RpcResponse<unknown> | RpcEvent;
		try {
			payload = JSON.parse(line) as RpcResponse<unknown> | RpcEvent;
		} catch {
			return;
		}

		if (isResponsePayload(payload) && payload.id && this.pendingRequests.has(payload.id)) {
			const pending = this.pendingRequests.get(payload.id);
			if (!pending) {
				return;
			}
			clearTimeout(pending.timer);
			this.pendingRequests.delete(payload.id);
			pending.resolve(payload);
			return;
		}

		for (const listener of this.eventListeners) {
			listener(payload as RpcEvent);
		}
	}

	private async send(command: RpcCommandBody): Promise<RpcSuccessResponse<unknown>> {
		if (!this.process?.stdin) {
			throw new Error("RPC client is not started.");
		}

		const id = `req_${++this.requestId}`;
		const payload: RpcCommand = { ...command, id };
		const response = await new Promise<RpcResponse<unknown>>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Timed out waiting for response to ${command.type}. ${this.stderr}`.trim()));
			}, 30000);

			this.pendingRequests.set(id, { resolve, reject, timer });
			this.process?.stdin?.write(`${JSON.stringify(payload)}\n`, (error) => {
				if (error) {
					clearTimeout(timer);
					this.pendingRequests.delete(id);
					reject(error);
				}
			});
		});

		if (!response.success) {
			throw new Error(response.error);
		}
		return response;
	}
}

function isResponsePayload(value: RpcResponse<unknown> | RpcEvent): value is RpcResponse<unknown> {
	return value.type === "response";
}

function getResponseData<T>(response: RpcSuccessResponse<unknown>): T {
	return (response.data ?? {}) as T;
}

function extractAssistantText(message: unknown): string | null {
	if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
		return null;
	}

	const text = message.content
		.map((block) => {
			if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
				return "";
			}
			return block.text;
		})
		.join("")
		.trim();
	return text || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
