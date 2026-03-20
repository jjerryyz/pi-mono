/**
 * Minimal Socket.IO client for `examples/rpc-socket.io.ts`.
 *
 * Usage (from packages/coding-agent):
 *   npx tsx examples/rpc-socket.io-client.ts
 *   npx tsx examples/rpc-socket.io-client.ts "Reply with exactly: RPC ok"
 *
 * Optional env:
 *   RPC_SOCKET_IO_URL=http://localhost:3338
 */

import { io, type Socket } from "socket.io-client";

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

type ServerToClientEvents = {
	ready: (payload: ReadyPayload) => void;
	delta: (payload: DeltaPayload) => void;
	tool_start: (payload: ToolStartPayload) => void;
	tool_end: (payload: ToolEndPayload) => void;
	tool_call: (payload: ToolCallPayload) => void;
	done: (payload: DonePayload) => void;
	agent_error: (payload: ErrorPayload) => void;
};

type ClientToServerEvents = {
	get_state: (ack: (response: ReadyPayload | { error: string }) => void) => void;
	prompt: (request: PromptRequest, ack: (response: AckResponse) => void) => void;
	abort: (ack: (response: AckResponse) => void) => void;
};

type RpcClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

async function main(): Promise<void> {
	const promptText = process.argv.slice(2).join(" ").trim() || "Reply with exactly: RPC ok";
	const url = process.env.RPC_SOCKET_IO_URL || "http://localhost:3338";

	const socket: RpcClientSocket = io(url, {
		transports: ["websocket", "polling"],
	});

	socket.on("connect", () => {
		console.log("[client] connected:", socket.id);
	});

	socket.on("disconnect", (reason) => {
		console.log("[client] disconnected:", reason);
	});

	socket.on("ready", (payload) => {
		console.log("[ready]", JSON.stringify(payload));
	});

	socket.on("delta", (payload) => {
		process.stdout.write(payload.delta);
	});

	socket.on("tool_start", (payload) => {
		process.stdout.write(`\n[tool:start] ${payload.toolName} ${JSON.stringify(payload.args)}\n`);
	});

	socket.on("tool_end", (payload) => {
		process.stdout.write(`\n[tool:end] ${payload.toolName} error=${payload.isError}\n`);
	});

	socket.on("tool_call", (payload) => {
		process.stdout.write(`\n[tool:call] ${JSON.stringify(payload.toolCall)}\n`);
	});

	const finished = new Promise<void>((resolve, reject) => {
		socket.on("done", (payload) => {
			process.stdout.write("\n");
			console.log("[done]", JSON.stringify(payload));
			resolve();
		});

		socket.on("agent_error", (payload) => {
			process.stdout.write("\n");
			reject(new Error(payload.message));
		});
	});

	try {
		const state = await socket.timeout(10000).emitWithAck("get_state");
		if ("error" in state) {
			throw new Error(state.error);
		}

		console.log("[client] current model:", state.model ?? "(none)");
		console.log("[client] prompting:", JSON.stringify(promptText));

		const ack = await socket.timeout(10000).emitWithAck("prompt", {
			message: promptText,
			reset: true,
		});
		if (!ack.ok) {
			throw new Error(ack.error);
		}

		await finished;
	} finally {
		socket.disconnect();
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
