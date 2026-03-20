/**
 * Minimal external client for pi RPC mode.
 *
 * Spawns `node dist/cli.js --mode rpc`, sends JSONL commands on stdin, reads
 * JSONL events/responses on stdout. This is the opposite of
 * `examples/extensions/rpc-demo.ts`, which runs *inside* pi as an extension.
 *
 * Prerequisites: build the package (`npm run build` in packages/coding-agent).
 * Set API keys / model as you would for normal `pi` (env or auth storage).
 *
 * Usage (from packages/coding-agent):
 *   npx tsx examples/rpc-minimal.ts
 *   npx tsx examples/rpc-minimal.ts "your prompt here"
 *
 * Optional env: PI_PROVIDER, PI_MODEL. If omitted, pi uses its configured default.
 *
 * `--no-extensions` avoids loading extensions from settings/cwd. Extensions that
 * call blocking RPC UI (select, confirm, input, editor) require the client to
 * answer `extension_ui_request` lines on stdout; otherwise the agent never
 * finishes and `waitForIdle()` times out (see `examples/rpc-extension-ui.ts`).
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
	const promptText = process.argv.slice(2).join(" ").trim() || "Reply with exactly: RPC ok";
	const provider = process.env.PI_PROVIDER || "openrouter";
	const model = process.env.PI_MODEL || "minimax/minimax-m2.5";

	const client = new RpcClient({
		cliPath: join(__dirname, "../dist/cli.js"),
		cwd: process.cwd(),
		// --no-session: ephemeral chat; --no-extensions: no blocking UI from extensions
		args: ["--no-session", "--no-extensions"],
		...(provider ? { provider } : {}),
		...(model ? { model } : {}),
	});

	client.onEvent((event) => {
		if (event.type === "message_update") {
			const e = event.assistantMessageEvent;
			if (e.type === "text_delta" || e.type === "thinking_delta") {
				process.stdout.write(e.delta);
			}
		}
		if (event.type === "agent_end") {
			process.stdout.write("\n");
		}
	});

	await client.start();

	try {
		const state = await client.getState();
		console.log("[rpc] session model:", state.model?.provider, state.model?.id);
		if (!state.model) {
			throw new Error("No model configured. Set PI_PROVIDER/PI_MODEL or configure a default pi model first.");
		}

		const waitForPromptResult = new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timeout waiting for prompt result. Stderr: ${client.getStderr()}`));
			}, 60000);

			const unsubscribe = client.onEvent((event) => {
				if (event.type === "agent_end") {
					clearTimeout(timeout);
					unsubscribe();
					resolve();
					return;
				}

				const maybeResponse = event as unknown as {
					type?: string;
					command?: string;
					success?: boolean;
					error?: string;
				};
				if (
					maybeResponse.type === "response" &&
					maybeResponse.command === "prompt" &&
					maybeResponse.success === false
				) {
					clearTimeout(timeout);
					unsubscribe();
					reject(new Error(maybeResponse.error ?? "Prompt failed"));
				}
			});
		});

		console.log("[rpc] prompting:", JSON.stringify(promptText));
		await client.prompt(promptText);
		await waitForPromptResult;
		const last = await client.getLastAssistantText();
		if (last) {
			console.log("[rpc] last assistant text:", last.slice(0, 500));
			return;
		}

		const messages = await client.getMessages();
		const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
		if (lastAssistant?.errorMessage) {
			console.log("[rpc] assistant error:", lastAssistant.errorMessage);
			return;
		}

		console.log("[rpc] last assistant text:", "(empty)");
	} finally {
		await client.stop();
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
