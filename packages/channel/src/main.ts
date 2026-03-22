#!/usr/bin/env node

import { resolve } from "node:path";
import { createChannelBridgeServer } from "./server.js";

interface CliOptions {
	cwd: string;
	host: string;
	port: number;
	dataDir: string;
	provider?: string;
	model?: string;
	piCliPath?: string;
	allowedSources?: Set<string>;
	allowedSenders?: Set<string>;
}

function printHelp(): void {
	console.log(`pi-channel - standalone channel bridge for pi

Usage:
  pi-channel [options] [working-directory]

Options:
  --host <host>            Listen host (default: 127.0.0.1)
  --port <port>            Listen port (default: 8788)
  --data-dir <dir>         Storage directory (default: <cwd>/.pi-channel)
  --provider <name>        Optional pi provider override
  --model <id>             Optional pi model override
  --pi-cli <path>          Explicit path to pi CLI entrypoint
  --allow-sources <csv>    Comma-separated source allowlist
  --allow-senders <csv>    Comma-separated sender ID allowlist
  --help                   Show this help
`);
}

function parseCsvSet(value: string | undefined): Set<string> | undefined {
	if (!value) {
		return undefined;
	}
	const items = value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
	return items.length > 0 ? new Set(items) : undefined;
}

function parseArgs(argv: string[]): CliOptions | null {
	let cwd = process.cwd();
	let host = "127.0.0.1";
	let port = 8788;
	let dataDir: string | undefined;
	let provider: string | undefined;
	let model: string | undefined;
	let piCliPath: string | undefined;
	let allowSources: string | undefined;
	let allowSenders: string | undefined;

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") {
			printHelp();
			return null;
		}
		if (arg === "--host" && index + 1 < argv.length) {
			host = argv[++index];
			continue;
		}
		if (arg === "--port" && index + 1 < argv.length) {
			port = Number(argv[++index]);
			continue;
		}
		if (arg === "--data-dir" && index + 1 < argv.length) {
			dataDir = argv[++index];
			continue;
		}
		if (arg === "--provider" && index + 1 < argv.length) {
			provider = argv[++index];
			continue;
		}
		if (arg === "--model" && index + 1 < argv.length) {
			model = argv[++index];
			continue;
		}
		if (arg === "--pi-cli" && index + 1 < argv.length) {
			piCliPath = argv[++index];
			continue;
		}
		if (arg === "--allow-sources" && index + 1 < argv.length) {
			allowSources = argv[++index];
			continue;
		}
		if (arg === "--allow-senders" && index + 1 < argv.length) {
			allowSenders = argv[++index];
			continue;
		}
		if (!arg.startsWith("-")) {
			cwd = resolve(arg);
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	if (!Number.isFinite(port) || port <= 0) {
		throw new Error(`Invalid port: ${port}`);
	}

	return {
		cwd,
		host,
		port,
		dataDir: resolve(dataDir ?? `${cwd}/.pi-channel`),
		...(provider ? { provider } : {}),
		...(model ? { model } : {}),
		...(piCliPath ? { piCliPath: resolve(piCliPath) } : {}),
		...(parseCsvSet(allowSources) ? { allowedSources: parseCsvSet(allowSources) } : {}),
		...(parseCsvSet(allowSenders) ? { allowedSenders: parseCsvSet(allowSenders) } : {}),
	};
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	if (!options) {
		return;
	}

	const server = createChannelBridgeServer(options);
	await server.start();

	console.log(`[pi-channel] listening on http://${options.host}:${options.port}`);
	console.log(`[pi-channel] workspace: ${options.cwd}`);
	console.log(`[pi-channel] data dir: ${options.dataDir}`);
	if (options.provider || options.model) {
		console.log(`[pi-channel] model override: ${options.provider ?? "(default)"}/${options.model ?? "(default)"}`);
	}
	console.log("[pi-channel] routes: GET /health, POST /channel/event, GET /channel/replies");

	const shutdown = async () => {
		await server.stop();
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
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
