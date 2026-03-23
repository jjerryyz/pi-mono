import { mkdirSync } from "node:fs";
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Server, type Socket } from "socket.io";
import { PiRpcClient, type RpcEvent } from "./rpc-client.js";
import { ChannelStore, ensureDataDir } from "./store.js";
import type {
	BridgeReadyPayload,
	BridgeState,
	ChannelBridgeOptions,
	ChannelEventAck,
	ChannelInboundEvent,
	ChannelReplyRecord,
	ChannelState,
	InternalReplyPayload,
	SubscribeRequest,
} from "./types.js";

type ClientToServerEvents = {
	get_state: (ack: (state: BridgeState) => void) => void;
	subscribe: (request: SubscribeRequest, ack: (response: ChannelEventAck) => void) => void;
	unsubscribe: (request: SubscribeRequest, ack: (response: ChannelEventAck) => void) => void;
	channel_event: (event: ChannelInboundEvent, ack: (response: ChannelEventAck) => void) => void;
};

type ServerToClientEvents = {
	ready: (payload: BridgeReadyPayload) => void;
	reply: (reply: ChannelReplyRecord) => void;
	channel_error: (payload: { channelId: string; error: string; timestamp: string }) => void;
};

type ChannelSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeMeta(meta: unknown): Record<string, string> | undefined {
	if (!isRecord(meta)) {
		return undefined;
	}

	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(meta)) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
			continue;
		}
		if (typeof value === "string") {
			result[key] = value;
		} else if (typeof value === "number" || typeof value === "boolean") {
			result[key] = String(value);
		}
	}

	return Object.keys(result).length > 0 ? result : undefined;
}

function escapeAttribute(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function formatChannelPrompt(event: ChannelInboundEvent): string {
	const attributes: string[] = [
		`source="${escapeAttribute(event.source)}"`,
		`channel_id="${escapeAttribute(event.channelId)}"`,
	];
	for (const [key, value] of Object.entries(event.meta ?? {})) {
		attributes.push(`${key}="${escapeAttribute(value)}"`);
	}

	return `<channel ${attributes.join(" ")}>\n${event.content}\n</channel>`;
}

function parseInboundEvent(value: unknown): ChannelInboundEvent | null {
	if (!isRecord(value)) {
		return null;
	}
	if (typeof value.channelId !== "string" || typeof value.source !== "string" || typeof value.content !== "string") {
		return null;
	}

	return {
		channelId: value.channelId,
		source: value.source,
		content: value.content,
		...(normalizeMeta(value.meta) ? { meta: normalizeMeta(value.meta) } : {}),
	};
}

function parseInternalReply(value: unknown): InternalReplyPayload | null {
	if (!isRecord(value)) {
		return null;
	}
	if (typeof value.channelId !== "string" || typeof value.text !== "string") {
		return null;
	}

	const payload: InternalReplyPayload = {
		channelId: value.channelId,
		text: value.text,
	};

	if (typeof value.threadId === "string") {
		payload.threadId = value.threadId;
	}
	const meta = normalizeMeta(value.meta);
	if (meta) {
		payload.meta = meta;
	}
	if (typeof value.sessionId === "string") {
		payload.sessionId = value.sessionId;
	}
	return payload;
}

function parseSubscribeRequest(value: unknown): SubscribeRequest | null {
	if (!isRecord(value) || typeof value.channelId !== "string") {
		return null;
	}

	return { channelId: value.channelId };
}

function getSenderId(event: ChannelInboundEvent): string | undefined {
	return event.meta?.sender_id ?? event.meta?.user_id ?? event.meta?.from_id;
}

function roomForChannel(channelId: string): string {
	return `channel:${encodeURIComponent(channelId)}`;
}

function previewText(text: string, maxLength = 80): string {
	const normalized = text.replaceAll(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) {
		return normalized;
	}
	return `${normalized.slice(0, maxLength - 1)}...`;
}

function extractTextFromAgentMessage(message: unknown): string | null {
	if (!isRecord(message) || !Array.isArray(message.content)) {
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

function describeRpcEvent(event: RpcEvent): string | null {
	switch (event.type) {
		case "agent_start":
			return "rpc agent started";
		case "turn_start":
			return `rpc turn ${typeof event.turnIndex === "number" ? event.turnIndex : "?"} started`;
		case "message_start":
			if (isRecord(event.message) && typeof event.message.role === "string") {
				return `rpc message start: ${event.message.role}`;
			}
			return "rpc message start";
		case "message_update":
			if (!isRecord(event.assistantMessageEvent) || typeof event.assistantMessageEvent.type !== "string") {
				return null;
			}
			switch (event.assistantMessageEvent.type) {
				case "thinking_start":
					return "rpc assistant thinking";
				case "toolcall_start":
					return "rpc assistant preparing tool call";
				case "text_start":
					return "rpc assistant responding";
				default:
					return null;
			}
		case "message_end":
			if (isRecord(event.message) && event.message.role === "assistant") {
				const text = extractTextFromAgentMessage(event.message);
				return text ? `rpc assistant done: ${previewText(text)}` : "rpc assistant done";
			}
			if (isRecord(event.message) && typeof event.message.role === "string") {
				return `rpc message end: ${event.message.role}`;
			}
			return "rpc message end";
		case "tool_execution_start":
			return typeof event.toolName === "string" ? `rpc tool start: ${event.toolName}` : "rpc tool start";
		case "tool_execution_update":
			return typeof event.toolName === "string" ? `rpc tool update: ${event.toolName}` : "rpc tool update";
		case "tool_execution_end":
			if (typeof event.toolName === "string") {
				return `rpc tool ${event.isError === true ? "error" : "done"}: ${event.toolName}`;
			}
			return `rpc tool ${event.isError === true ? "error" : "done"}`;
		case "turn_end":
			return `rpc turn ${typeof event.turnIndex === "number" ? event.turnIndex : "?"} ended`;
		case "agent_end":
			return "rpc agent ended";
		default:
			return null;
	}
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
	res.writeHead(statusCode, {
		"content-type": "application/json; charset=utf-8",
		"access-control-allow-origin": "*",
		"access-control-allow-methods": "GET,POST,OPTIONS",
		"access-control-allow-headers": "content-type",
	});
	res.end(JSON.stringify(body, null, 2));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	const body = Buffer.concat(chunks).toString("utf-8").trim();
	return body ? JSON.parse(body) : {};
}

function resolvePiCliPath(explicitPath: string | undefined): string {
	if (explicitPath) {
		return explicitPath;
	}

	const require = createRequire(import.meta.url);
	const packageEntry = require.resolve("@mariozechner/pi-coding-agent");
	return join(dirname(packageEntry), "cli.js");
}

function getBridgeCallbackUrl(port: number): string {
	return `http://127.0.0.1:${port}`;
}

class ChannelRuntime {
	private client: PiRpcClient | null = null;
	private queueChain = Promise.resolve();
	private pendingCount = 0;

	private log(message: string): void {
		console.log(`[pi-channel] [${this.channelId}] ${message}`);
	}

	constructor(
		private readonly options: ChannelBridgeOptions,
		private readonly store: ChannelStore,
		private readonly channelId: string,
		private readonly onError: (channelId: string, error: Error) => void,
		private readonly onReply: (reply: InternalReplyPayload) => Promise<void>,
	) {}

	getState(): ChannelState {
		return {
			channelId: this.channelId,
			pendingCount: this.pendingCount,
			started: this.client !== null,
		};
	}

	enqueue(event: ChannelInboundEvent): void {
		this.pendingCount++;
		this.log(`queued inbound event; pending=${this.pendingCount}`);
		this.queueChain = this.queueChain
			.then(async () => {
				const client = await this.ensureStarted();
				const startedAt = Date.now();
				this.log(`dispatching prompt: ${previewText(event.content)}`);
				await this.store.logInbound({
					...event,
					timestamp: new Date().toISOString(),
				});
				const result = await client.promptAndWait(formatChannelPrompt(event), 180000);
				this.log(
					`prompt completed in ${Date.now() - startedAt}ms; tools=${
						result.successfulToolNames.length > 0 ? result.successfulToolNames.join(", ") : "none"
					}`,
				);
				if (!result.successfulToolNames.includes("channel_reply") && result.assistantText) {
					this.log(`persisting assistant reply: ${previewText(result.assistantText)}`);
					await this.onReply({
						channelId: this.channelId,
						text: result.assistantText,
					});
				}
			})
			.catch((error: unknown) => {
				this.log(`prompt failed: ${error instanceof Error ? error.message : String(error)}`);
				this.onError(this.channelId, error instanceof Error ? error : new Error(String(error)));
			})
			.finally(() => {
				this.pendingCount--;
				this.log(`queue settled; pending=${this.pendingCount}`);
			});
	}

	async stop(): Promise<void> {
		if (!this.client) {
			return;
		}
		await this.client.stop();
		this.client = null;
	}

	private async ensureStarted(): Promise<PiRpcClient> {
		if (this.client) {
			return this.client;
		}

		const cliPath = resolvePiCliPath(this.options.piCliPath);
		const extensionPath = fileURLToPath(new URL("./extension.js", import.meta.url));
		const sessionDir = this.store.getSessionDir(this.channelId);
		mkdirSync(sessionDir, { recursive: true });

		const client = new PiRpcClient({
			cliPath,
			cwd: this.options.cwd,
			args: ["--session-dir", sessionDir, "--no-extensions", "--extension", extensionPath],
			env: {
				PI_CHANNEL_BRIDGE_URL: getBridgeCallbackUrl(this.options.port),
				PI_CHANNEL_CHANNEL_ID: this.channelId,
			},
			...(this.options.provider ? { provider: this.options.provider } : {}),
			...(this.options.model ? { model: this.options.model } : {}),
		});
		await client.start();
		client.onEvent((event) => {
			const description = describeRpcEvent(event);
			if (description) {
				this.log(description);
			}
		});
		this.log("rpc client started");
		await client.setSessionName(`channel:${this.channelId}`);
		this.log("rpc session name set");
		this.client = client;
		return client;
	}
}

export class ChannelBridgeServer {
	private readonly store: ChannelStore;
	private readonly runtimes = new Map<string, ChannelRuntime>();
	private readonly httpServer: HttpServer;
	private readonly io: Server<ClientToServerEvents, ServerToClientEvents>;
	private listening = false;

	constructor(private readonly options: ChannelBridgeOptions) {
		ensureDataDir(options.dataDir);
		this.store = new ChannelStore(options.dataDir);
		this.httpServer = createServer((req, res) => {
			void this.handleHttpRequest(req, res).catch((error) => {
				sendJson(res, 500, {
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				});
			});
		});
		this.io = new Server<ClientToServerEvents, ServerToClientEvents>(this.httpServer, {
			cors: {
				origin: "*",
			},
		});
		this.io.on("connection", (socket) => {
			void this.handleSocketConnection(socket);
		});
	}

	async start(): Promise<void> {
		if (this.listening) {
			return;
		}

		await new Promise<void>((resolve) => {
			this.httpServer.listen(this.options.port, this.options.host, () => resolve());
		});
		this.listening = true;
	}

	async stop(): Promise<void> {
		for (const runtime of this.runtimes.values()) {
			await runtime.stop();
		}
		this.runtimes.clear();

		await new Promise<void>((resolve) => {
			this.io.close(() => resolve());
		});
		await new Promise<void>((resolve, reject) => {
			this.httpServer.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve();
			});
		});
		this.listening = false;
	}

	getState(): BridgeState {
		return {
			host: this.options.host,
			port: this.options.port,
			channelCount: this.runtimes.size,
			channels: Array.from(this.runtimes.values())
				.map((runtime) => runtime.getState())
				.sort((left, right) => left.channelId.localeCompare(right.channelId)),
		};
	}

	private async handleSocketConnection(socket: ChannelSocket): Promise<void> {
		socket.emit("ready", {
			ok: true,
			...this.getState(),
		});

		socket.on("get_state", (ack) => {
			ack(this.getState());
		});

		socket.on("subscribe", (request, ack) => {
			const parsed = parseSubscribeRequest(request);
			if (!parsed) {
				ack({ ok: false, error: "Expected payload: { channelId: string }" });
				return;
			}
			void socket.join(roomForChannel(parsed.channelId));
			ack({ ok: true, accepted: true });
		});

		socket.on("unsubscribe", (request, ack) => {
			const parsed = parseSubscribeRequest(request);
			if (!parsed) {
				ack({ ok: false, error: "Expected payload: { channelId: string }" });
				return;
			}
			void socket.leave(roomForChannel(parsed.channelId));
			ack({ ok: true, accepted: true });
		});

		socket.on("channel_event", async (event, ack) => {
			const result = await this.acceptInboundEvent(event);
			ack(result);
		});
	}

	private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (req.method === "OPTIONS") {
			sendJson(res, 204, {});
			return;
		}

		const url = new URL(req.url ?? "/", "http://localhost");

		if (req.method === "GET" && url.pathname === "/health") {
			sendJson(res, 200, {
				ok: true,
				...this.getState(),
			});
			return;
		}

		if (req.method === "GET" && url.pathname === "/channel/replies") {
			const channelId = url.searchParams.get("channelId");
			if (!channelId) {
				sendJson(res, 400, { ok: false, error: "Missing channelId query parameter." });
				return;
			}
			const after = Number(url.searchParams.get("after") ?? "0");
			sendJson(res, 200, {
				ok: true,
				replies: this.store.getReplies(channelId, Number.isFinite(after) ? after : 0),
			});
			return;
		}

		if (req.method === "POST" && url.pathname === "/channel/event") {
			const body = await readJsonBody(req);
			const result = await this.acceptInboundEvent(body);
			sendJson(res, result.ok ? 202 : 400, result);
			return;
		}

		if (req.method === "POST" && url.pathname === "/internal/reply") {
			const body = await readJsonBody(req);
			const reply = parseInternalReply(body);
			if (!reply) {
				sendJson(res, 400, { ok: false, error: "Expected payload: { channelId: string, text: string }" });
				return;
			}
			const record = await this.persistReply(reply);
			sendJson(res, 200, { ok: true, reply: record });
			return;
		}

		sendJson(res, 404, {
			ok: false,
			error: "Not found",
			routes: {
				health: "GET /health",
				channelEvent: "POST /channel/event",
				channelReplies: "GET /channel/replies?channelId=<id>&after=<n>",
				internalReply: "POST /internal/reply",
			},
		});
	}

	private async acceptInboundEvent(value: unknown): Promise<ChannelEventAck> {
		const event = parseInboundEvent(value);
		if (!event) {
			return {
				ok: false,
				error: "Expected payload: { channelId: string, source: string, content: string, meta?: object }",
			};
		}

		if (this.options.allowedSources && !this.options.allowedSources.has(event.source)) {
			return {
				ok: false,
				error: `Source "${event.source}" is not allowlisted.`,
			};
		}

		if (this.options.allowedSenders) {
			const senderId = getSenderId(event);
			if (!senderId || !this.options.allowedSenders.has(senderId)) {
				return {
					ok: false,
					error: "Sender is not allowlisted.",
				};
			}
		}

		this.getOrCreateRuntime(event.channelId).enqueue(event);
		return {
			ok: true,
			accepted: true,
			queued: true,
		};
	}

	private async persistReply(reply: InternalReplyPayload): Promise<ChannelReplyRecord> {
		const record = await this.store.logReply(reply);
		this.io.to(roomForChannel(record.channelId)).emit("reply", record);
		return record;
	}

	private getOrCreateRuntime(channelId: string): ChannelRuntime {
		const existing = this.runtimes.get(channelId);
		if (existing) {
			return existing;
		}

		const runtime = new ChannelRuntime(
			this.options,
			this.store,
			channelId,
			(failedChannelId, error) => {
				const payload = {
					channelId: failedChannelId,
					error: error.message,
					timestamp: new Date().toISOString(),
				};
				console.error(`[pi-channel] [${failedChannelId}] ${error.message}`);
				this.io.to(roomForChannel(failedChannelId)).emit("channel_error", payload);
			},
			async (reply) => {
				await this.persistReply(reply);
			},
		);
		this.runtimes.set(channelId, runtime);
		return runtime;
	}
}

export function createChannelBridgeServer(options: ChannelBridgeOptions): ChannelBridgeServer {
	return new ChannelBridgeServer(options);
}
