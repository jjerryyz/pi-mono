/**
 * Minimal Socket.IO wrapper around pi RPC mode.
 *
 * Starts one long-lived RpcClient process and exposes:
 * - GET /health                      -> JSON status
 * - socket event "get_state"         -> ack with session state
 * - socket event "prompt"            -> starts a run, streams agent events
 * - socket event "abort"             -> abort current run
 *
 * Server -> client events during a prompt:
 * - "ready"
 * - "delta"
 * - "tool_start"
 * - "tool_end"
 * - "tool_call"
 * - "done"
 * - "agent_error"
 *
 * Usage (from packages/coding-agent):
 *   npx tsx examples/rpc-socket.io.ts
 *
 * Optional env: PORT, PI_PROVIDER, PI_MODEL.
 *
 * Example browser client:
 *   import { io } from "socket.io-client";
 *   const socket = io("http://localhost:3338");
 *   socket.on("delta", (event) => console.log(event.delta));
 *   socket.emit("prompt", { message: "Reply with exactly: RPC ok" }, console.log);
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import { Server, type Socket } from "socket.io";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3338);
const provider = process.env.PI_PROVIDER || "openrouter";
const model = process.env.PI_MODEL || "minimax/minimax-m2.5";

type JsonRecord = Record<string, unknown>;

type PromptFailureResponse = {
	type?: string;
	command?: string;
	success?: boolean;
	error?: string;
};

type PromptRequest = {
	message: string;
	reset?: boolean;
};

type AckResponse =
	| { ok: true }
	| {
			ok: false;
			error: string;
	  };

type ReadyPayload = {
	busy: boolean;
	model: string | null;
	isStreaming: boolean;
	messageCount: number;
	reset?: boolean;
};

type DeltaPayload = {
	type: "text_delta" | "thinking_delta";
	delta: string;
};

type ToolStartPayload = {
	toolName: string;
	args: unknown;
};

type ToolEndPayload = {
	toolName: string;
	isError: boolean;
	result: unknown;
};

type ToolCallPayload = {
	toolCall: unknown;
};

type DonePayload = {
	text: string;
	stopReason: string | null | undefined;
	model: string | null;
};

type ErrorPayload = {
	message: string;
};

type ClientToServerEvents = {
	get_state: (ack: (response: ReadyPayload | { error: string }) => void) => void;
	prompt: (request: PromptRequest, ack: (response: AckResponse) => void) => void;
	abort: (ack: (response: AckResponse) => void) => void;
};

type ServerToClientEvents = {
	ready: (payload: ReadyPayload) => void;
	delta: (payload: DeltaPayload) => void;
	tool_start: (payload: ToolStartPayload) => void;
	tool_end: (payload: ToolEndPayload) => void;
	tool_call: (payload: ToolCallPayload) => void;
	done: (payload: DonePayload) => void;
	agent_error: (payload: ErrorPayload) => void;
};

type RpcSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

const client = new RpcClient({
	cliPath: join(__dirname, "../dist/cli.js"),
	cwd: process.cwd(),
	args: ["--no-session", "--no-extensions"],
	...(provider ? { provider } : {}),
	...(model ? { model } : {}),
});

let busy = false;
let activeSocketId: string | null = null;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
	res.writeHead(statusCode, {
		"content-type": "application/json; charset=utf-8",
		"access-control-allow-origin": "*",
	});
	res.end(JSON.stringify(body, null, 2));
}

function isAssistantMessage(message: AgentMessage): message is Extract<AgentMessage, { role: "assistant" }> {
	return message.role === "assistant";
}

function extractAssistantText(message: { content: Array<{ type: string; text?: string }> } | undefined): string {
	if (!message) return "";

	return message.content
		.map((block) => {
			if (block.type === "text") return block.text;
			return "";
		})
		.filter(Boolean)
		.join("");
}

function isPromptFailureResponse(
	value: unknown,
): value is Required<Pick<PromptFailureResponse, "type" | "command" | "success">> & PromptFailureResponse {
	if (!isRecord(value)) return false;
	return value.type === "response" && value.command === "prompt" && value.success === false;
}

async function getReadyPayload(reset?: boolean): Promise<ReadyPayload> {
	const state = await client.getState();
	return {
		busy,
		model: state.model ? `${state.model.provider}/${state.model.id}` : null,
		isStreaming: state.isStreaming,
		messageCount: state.messageCount,
		...(typeof reset === "boolean" ? { reset } : {}),
	};
}

async function handlePrompt(
	socket: RpcSocket,
	request: PromptRequest,
	ack: (response: AckResponse) => void,
): Promise<void> {
	if (!isRecord(request) || typeof request.message !== "string" || !request.message.trim()) {
		ack({ ok: false, error: "Expected payload: { message: string, reset?: boolean }" });
		return;
	}

	if (busy) {
		ack({ ok: false, error: "Server is already streaming a prompt. Call abort or wait for completion." });
		return;
	}

	busy = true;
	activeSocketId = socket.id;
	ack({ ok: true });

	let finished = false;
	const reset = typeof request.reset === "boolean" ? request.reset : true;

	const finish = () => {
		if (finished) return;
		finished = true;
		busy = false;
		activeSocketId = null;
		unsubscribe();
		clearTimeout(timer);
	};

	const unsubscribe = client.onEvent((event: AgentEvent) => {
		if (finished || activeSocketId !== socket.id) return;
		const maybeFailure = event as unknown;

		if (isPromptFailureResponse(maybeFailure)) {
			socket.emit("agent_error", { message: maybeFailure.error ?? "Prompt failed" });
			finish();
			return;
		}

		if (event.type === "message_update") {
			const update = event.assistantMessageEvent;
			if (update.type === "text_delta" || update.type === "thinking_delta") {
				socket.emit("delta", { type: update.type, delta: update.delta });
			} else if (update.type === "toolcall_end") {
				socket.emit("tool_call", { toolCall: update.toolCall });
			} else if (update.type === "error") {
				socket.emit("agent_error", {
					message: update.error.errorMessage ?? (extractAssistantText(update.error) || "Prompt failed"),
				});
			}
			return;
		}

		if (event.type === "tool_execution_start") {
			socket.emit("tool_start", { toolName: event.toolName, args: event.args });
			return;
		}

		if (event.type === "tool_execution_end") {
			socket.emit("tool_end", {
				toolName: event.toolName,
				isError: event.isError,
				result: event.result,
			});
			return;
		}

		if (event.type === "agent_end") {
			const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
			const text = extractAssistantText(lastAssistant);

			if (lastAssistant?.errorMessage) {
				socket.emit("agent_error", { message: lastAssistant.errorMessage });
			} else {
				socket.emit("done", {
					text,
					stopReason: lastAssistant?.stopReason,
					model: lastAssistant ? `${lastAssistant.provider}/${lastAssistant.model}` : null,
				});
			}
			finish();
		}
	});

	const timer = setTimeout(() => {
		void client.abort().catch(() => {});
		if (activeSocketId === socket.id) {
			socket.emit("agent_error", {
				message: `Timed out waiting for prompt completion. Stderr: ${client.getStderr()}`,
			});
		}
		finish();
	}, 120000);

	try {
		if (reset) {
			const nextSession = await client.newSession();
			if (nextSession.cancelled) {
				socket.emit("agent_error", { message: "New session was cancelled by an extension." });
				finish();
				return;
			}
		}

		socket.emit("ready", await getReadyPayload(reset));
		await client.prompt(request.message);
	} catch (error) {
		socket.emit("agent_error", {
			message: error instanceof Error ? error.message : String(error),
		});
		finish();
	}
}

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (req.method === "OPTIONS") {
		res.writeHead(204, {
			"access-control-allow-origin": "*",
			"access-control-allow-methods": "GET,OPTIONS",
			"access-control-allow-headers": "content-type",
		});
		res.end();
		return;
	}

	if (req.method === "GET" && req.url === "/health") {
		sendJson(res, 200, await getReadyPayload());
		return;
	}

	sendJson(res, 404, {
		error: "Not found",
		routes: {
			health: "GET /health",
			socket: "Connect with Socket.IO and use get_state / prompt / abort events",
		},
	});
}

const httpServer = createServer((req, res) => {
	void handleHttpRequest(req, res).catch((error) => {
		sendJson(res, 500, {
			error: error instanceof Error ? error.message : String(error),
		});
	});
});

const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
	cors: {
		origin: "*",
	},
});

io.on("connection", (socket) => {
	void getReadyPayload()
		.then((payload) => socket.emit("ready", payload))
		.catch((error) => {
			socket.emit("agent_error", {
				message: error instanceof Error ? error.message : String(error),
			});
		});

	socket.on("get_state", (ack) => {
		void getReadyPayload()
			.then((payload) => ack(payload))
			.catch((error) => {
				ack({ error: error instanceof Error ? error.message : String(error) });
			});
	});

	socket.on("prompt", (request, ack) => {
		void handlePrompt(socket, request, ack);
	});

	socket.on("abort", (ack) => {
		void client
			.abort()
			.then(() => ack({ ok: true }))
			.catch((error) => {
				ack({ ok: false, error: error instanceof Error ? error.message : String(error) });
			});
	});

	socket.on("disconnect", () => {
		if (activeSocketId === socket.id) {
			void client.abort().catch(() => {});
		}
	});
});

async function main(): Promise<void> {
	await client.start();

	httpServer.listen(port, () => {
		console.log(`[rpc-socket.io] listening on http://localhost:${port}`);
		console.log(`[rpc-socket.io] model override: ${provider}/${model}`);
		console.log("[rpc-socket.io] socket events: get_state, prompt, abort");
	});

	const shutdown = async () => {
		io.close();
		httpServer.close();
		await client.stop();
		process.exit(0);
	};

	process.on("SIGINT", () => {
		void shutdown();
	});
	process.on("SIGTERM", () => {
		void shutdown();
	});
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
