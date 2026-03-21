/**
 * Standalone loop CLI for the loop extension example.
 *
 * Starts a long-lived `pi --mode rpc` subprocess, explicitly loads the loop
 * extension, forwards `/loop ...` commands, and keeps the process alive after
 * scheduling so the in-memory jobs can continue firing.
 *
 * Usage (from packages/coding-agent):
 *   npx tsx examples/extensions/loop/cli.ts schedule 5m "check deploys"
 *   npx tsx examples/extensions/loop/cli.ts list
 *   npx tsx examples/extensions/loop/cli.ts cancel job-1
 *   npx tsx examples/extensions/loop/cli.ts 5m "check deploys"
 */

import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { RpcClient } from "../../../src/modes/rpc/rpc-client.js";
import type { RpcExtensionUIRequest } from "../../../src/modes/rpc/rpc-types.js";
import { buildLoopSlashCommand, LOOP_CLI_USAGE } from "./command.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const provider = process.env.PI_PROVIDER;
const model = process.env.PI_MODEL;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isExtensionUiRequest(event: unknown): event is RpcExtensionUIRequest {
	return typeof event === "object" && event !== null && (event as { type?: string }).type === "extension_ui_request";
}

function formatInteractiveLoopCommand(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) throw new Error(LOOP_CLI_USAGE);
	if (trimmed.startsWith("/loop ")) return trimmed;
	if (trimmed === "list") return "/loop list";
	if (/^cancel\s+\S+$/.test(trimmed)) return `/loop ${trimmed}`;
	return `/loop ${trimmed}`;
}

async function waitForLoopCommandCompletion(
	client: RpcClient,
	getLastEventAt: () => number,
	hasAgentEnded: () => boolean,
	getBlockingUiMethod: () => string | null,
): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < 10_000) {
		const blockingMethod = getBlockingUiMethod();
		if (blockingMethod) {
			throw new Error(`Loop CLI does not support blocking extension UI requests (${blockingMethod}).`);
		}

		if (hasAgentEnded()) return;

		const state = await client.getState();
		if (!state.isStreaming && Date.now() - getLastEventAt() > 300) {
			return;
		}

		await sleep(100);
	}

	throw new Error(`Timed out waiting for loop command completion. Stderr: ${client.getStderr()}`);
}

async function sendLoopCommand(
	client: RpcClient,
	command: string,
	state: {
		lastEventAt: number;
		sawAgentEnd: boolean;
		blockingUiMethod: string | null;
	},
): Promise<void> {
	state.lastEventAt = Date.now();
	state.sawAgentEnd = false;
	state.blockingUiMethod = null;

	await client.prompt(command);
	await waitForLoopCommandCompletion(
		client,
		() => state.lastEventAt,
		() => state.sawAgentEnd,
		() => state.blockingUiMethod,
	);
}

async function startInteractivePrompt(
	client: RpcClient,
	state: { lastEventAt: number; sawAgentEnd: boolean; blockingUiMethod: string | null },
) {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		console.log("[loop-cli] scheduler running. Press Ctrl+C to stop.");
		return;
	}

	console.log("[loop-cli] scheduler running. Type `list`, `cancel <job-id>`, another schedule, or `exit`.");
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
		prompt: "loop> ",
	});

	rl.prompt();
	for await (const line of rl) {
		const trimmed = line.trim();
		if (!trimmed) {
			rl.prompt();
			continue;
		}
		if (trimmed === "exit" || trimmed === "quit") {
			rl.close();
			break;
		}

		try {
			await sendLoopCommand(client, formatInteractiveLoopCommand(trimmed), state);
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
		}
		rl.prompt();
	}
}

async function main(): Promise<void> {
	const cliArgs = process.argv.slice(2);
	if (cliArgs.length === 0 || cliArgs.includes("--help") || cliArgs.includes("-h")) {
		console.log(LOOP_CLI_USAGE);
		return;
	}

	const slashCommand = buildLoopSlashCommand(cliArgs);
	const shouldStayRunning = !slashCommand.endsWith(" list") && !slashCommand.includes("/loop cancel ");
	const client = new RpcClient({
		cliPath: join(__dirname, "../../../dist/cli.js"),
		cwd: process.cwd(),
		args: ["--no-session", "--no-extensions", "--extension", join(__dirname, "index.ts")],
		...(provider ? { provider } : {}),
		...(model ? { model } : {}),
	});

	const loopState = {
		lastEventAt: Date.now(),
		sawAgentEnd: false,
		blockingUiMethod: null as string | null,
	};

	client.onEvent((event: AgentEvent) => {
		loopState.lastEventAt = Date.now();

		const unknownEvent = event as unknown;
		if (isExtensionUiRequest(unknownEvent)) {
			if (
				unknownEvent.method === "select" ||
				unknownEvent.method === "confirm" ||
				unknownEvent.method === "input" ||
				unknownEvent.method === "editor"
			) {
				loopState.blockingUiMethod = unknownEvent.method;
				return;
			}

			if (unknownEvent.method === "notify") {
				const level = unknownEvent.notifyType ?? "info";
				console.log(`[${level}] ${unknownEvent.message}`);
			}
			return;
		}

		if (event.type === "message_update") {
			const update = event.assistantMessageEvent;
			if (update.type === "text_delta" || update.type === "thinking_delta") {
				process.stdout.write(update.delta);
			}
			return;
		}

		if (event.type === "agent_end") {
			loopState.sawAgentEnd = true;
			process.stdout.write("\n");
		}
	});

	await client.start();

	try {
		const sessionState = await client.getState();
		if (!sessionState.model) {
			throw new Error("No model configured. Set PI_PROVIDER/PI_MODEL or configure a default pi model first.");
		}

		await sendLoopCommand(client, slashCommand, loopState);

		if (!shouldStayRunning) return;
		await startInteractivePrompt(client, loopState);
	} finally {
		await client.stop();
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
