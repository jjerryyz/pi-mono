/**
 * Minimal HTTP wrapper around pi RPC mode with streaming output over SSE.
 *
 * Starts one long-lived RpcClient process and exposes:
 * - GET /health        -> JSON status
 * - POST /prompt       -> text/event-stream
 * - POST /abort        -> abort current run
 *
 * Request body for POST /prompt:
 *   { "message": "Explain RPC", "reset": true }
 *
 * Usage (from packages/coding-agent):
 *   npx tsx examples/rpc-server.ts
 *
 * Test with curl:
 *   curl -N -X POST http://localhost:3337/prompt ^
 *     -H "content-type: application/json" ^
 *     -d "{\"message\":\"Reply with exactly: RPC ok\"}"
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3337);
const provider = process.env.PI_PROVIDER || "openrouter";
const model = process.env.PI_MODEL || "minimax/minimax-m2.5";

type PromptFailureResponse = {
	type?: string;
	command?: string;
	success?: boolean;
	error?: string;
};

type JsonRecord = Record<string, unknown>;

const client = new RpcClient({
	cliPath: join(__dirname, "../dist/cli.js"),
	cwd: process.cwd(),
	args: ["--no-session", "--no-extensions"],
	...(provider ? { provider } : {}),
	...(model ? { model } : {}),
});

let busy = false;

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

function sendSse(res: ServerResponse, event: string, data: unknown): void {
	res.write(`event: ${event}\n`);
	res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];

	for await (const chunk of req) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}

	const body = Buffer.concat(chunks).toString("utf8").trim();
	if (!body) return {};
	return JSON.parse(body) as unknown;
}

function isAssistantMessage(message: AgentMessage): message is Extract<AgentMessage, { role: "assistant" }> {
	return message.role === "assistant";
}

function extractAssistantText(message: Extract<AgentMessage, { role: "assistant" }> | undefined): string {
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

async function streamPrompt(res: ServerResponse, message: string, reset: boolean): Promise<void> {
	if (busy) {
		sendJson(res, 409, { error: "Server is already streaming a prompt. Call /abort or wait for completion." });
		return;
	}

	busy = true;
	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache, no-transform",
		connection: "keep-alive",
		"access-control-allow-origin": "*",
	});
	res.write(": connected\n\n");

	let finished = false;
	let clientClosed = false;

	const finish = () => {
		if (finished) return;
		finished = true;
		busy = false;
		unsubscribe();
		clearTimeout(timer);
		res.end();
	};

	res.on("close", () => {
		clientClosed = true;
		void client.abort().catch(() => {});
		finish();
	});

	const unsubscribe = client.onEvent((event: AgentEvent) => {
		if (clientClosed || finished) return;
		const maybeFailure = event as unknown;

		if (isPromptFailureResponse(maybeFailure)) {
			sendSse(res, "error", { message: maybeFailure.error ?? "Prompt failed" });
			finish();
			return;
		}

		if (event.type === "message_update") {
			const update = event.assistantMessageEvent;
			if (update.type === "text_delta") {
				sendSse(res, "delta", { type: update.type, delta: update.delta });
			} else if (update.type === "toolcall_end") {
				sendSse(res, "tool_call", { toolCall: update.toolCall });
			} else if (update.type === "error") {
				sendSse(res, "error", { message: update.error });
			}
			return;
		}

		if (event.type === "tool_execution_start") {
			sendSse(res, "tool_start", { toolName: event.toolName, args: event.args });
			return;
		}

		if (event.type === "tool_execution_end") {
			sendSse(res, "tool_end", {
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
				sendSse(res, "error", { message: lastAssistant.errorMessage });
			} else {
				sendSse(res, "done", {
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
		sendSse(res, "error", { message: `Timed out waiting for prompt completion. Stderr: ${client.getStderr()}` });
		finish();
	}, 120000);

	try {
		if (reset) {
			const nextSession = await client.newSession();
			if (nextSession.cancelled) {
				sendSse(res, "error", { message: "New session was cancelled by an extension." });
				finish();
				return;
			}
		}

		const state = await client.getState();
		sendSse(res, "ready", {
			model: state.model ? `${state.model.provider}/${state.model.id}` : null,
			reset,
		});

		await client.prompt(message);
	} catch (error) {
		sendSse(res, "error", {
			message: error instanceof Error ? error.message : String(error),
		});
		finish();
	}
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (req.method === "OPTIONS") {
		res.writeHead(204, {
			"access-control-allow-origin": "*",
			"access-control-allow-methods": "GET,POST,OPTIONS",
			"access-control-allow-headers": "content-type",
		});
		res.end();
		return;
	}

	if (req.method === "GET" && req.url === "/health") {
		const state = await client.getState();
		sendJson(res, 200, {
			ok: true,
			busy,
			model: state.model,
			isStreaming: state.isStreaming,
			messageCount: state.messageCount,
		});
		return;
	}

	if (req.method === "POST" && req.url === "/abort") {
		await client.abort();
		sendJson(res, 200, { ok: true });
		return;
	}

	if (req.method === "POST" && req.url === "/prompt") {
		const body = await readJsonBody(req);
		if (!isRecord(body) || typeof body.message !== "string" || !body.message.trim()) {
			sendJson(res, 400, { error: "Expected JSON body: { message: string, reset?: boolean }" });
			return;
		}

		const reset = typeof body.reset === "boolean" ? body.reset : true;
		await streamPrompt(res, body.message, reset);
		return;
	}

	sendJson(res, 404, {
		error: "Not found",
		routes: {
			health: "GET /health",
			prompt: "POST /prompt",
			abort: "POST /abort",
		},
	});
}

async function main(): Promise<void> {
	await client.start();

	const server = createServer((req, res) => {
		void handleRequest(req, res).catch((error) => {
			sendJson(res, 500, {
				error: error instanceof Error ? error.message : String(error),
			});
		});
	});

	server.listen(port, () => {
		console.log(`[rpc-server] listening on http://localhost:${port}`);
		console.log(`[rpc-server] model override: ${provider}/${model}`);
		console.log("[rpc-server] routes: GET /health, POST /prompt, POST /abort");
	});

	const shutdown = async () => {
		server.close();
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
