/**
 * WebSocket bridge server for the coding agent.
 *
 * Spawns `pi --mode rpc` as a child process and bridges WebSocket
 * text frames to stdin/stdout JSON lines. The RPC protocol is
 * identical -- this is purely a transport adapter.
 *
 * Usage:
 *   npx tsx src/server/index.ts [--port 3001] [--static dist/] [-- pi-args...]
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { type WebSocket, WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MIME_TYPES: Record<string, string> = {
	".html": "text/html",
	".js": "application/javascript",
	".css": "text/css",
	".json": "application/json",
	".png": "image/png",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
};

interface ServerOptions {
	port: number;
	staticDir?: string;
	piCommand: string;
	piArgs: string[];
}

function parseArgs(argv: string[]): ServerOptions {
	let port = 3001;
	let staticDir: string | undefined;
	const piArgs: string[] = [];
	let piCommand = "pi";
	let parsingPiArgs = false;

	for (let i = 2; i < argv.length; i++) {
		if (parsingPiArgs) {
			piArgs.push(argv[i]);
			continue;
		}
		if (argv[i] === "--") {
			parsingPiArgs = true;
			continue;
		}
		if (argv[i] === "--port" && i + 1 < argv.length) {
			port = Number.parseInt(argv[++i], 10);
		} else if (argv[i] === "--static" && i + 1 < argv.length) {
			staticDir = path.resolve(argv[++i]);
		} else if (argv[i] === "--pi" && i + 1 < argv.length) {
			piCommand = argv[++i];
		}
	}

	return { port, staticDir, piCommand, piArgs };
}

function serveStatic(staticDir: string, req: http.IncomingMessage, res: http.ServerResponse): void {
	let urlPath = decodeURIComponent(req.url?.split("?")[0] || "/");
	if (urlPath === "/") urlPath = "/index.html";

	const filePath = path.resolve(staticDir, urlPath.slice(1));
	const resolvedStaticDir = path.resolve(staticDir);

	if (!filePath.startsWith(resolvedStaticDir + path.sep) && filePath !== resolvedStaticDir) {
		res.writeHead(403);
		res.end("Forbidden");
		return;
	}

	const ext = path.extname(filePath);
	const contentType = MIME_TYPES[ext] || "application/octet-stream";

	fs.readFile(filePath, (err, data) => {
		if (err) {
			res.writeHead(404);
			res.end("Not found");
			return;
		}
		res.writeHead(200, {
			"Content-Type": contentType,
			"Access-Control-Allow-Origin": "*",
		});
		res.end(data);
	});
}

function spawnPi(command: string, extraArgs: string[]): ChildProcess {
	const args = ["--mode", "rpc", ...extraArgs];

	// In the monorepo, allow running from source via tsx
	if (command === "pi-dev") {
		const cliPath = path.resolve(__dirname, "../../../../coding-agent/src/cli.ts");
		return spawn("npx", ["tsx", cliPath, ...args], {
			stdio: ["pipe", "pipe", "inherit"],
			shell: true,
		});
	}

	return spawn(command, args, {
		stdio: ["pipe", "pipe", "inherit"],
		shell: true,
	});
}

function bridgeConnection(ws: WebSocket, piCommand: string, piArgs: string[]): void {
	const pi = spawnPi(piCommand, piArgs);

	if (!pi.stdin || !pi.stdout) {
		console.error("[server] Failed to open pipes to pi process");
		ws.close(4002, "Failed to start agent process");
		return;
	}

	const rl = readline.createInterface({ input: pi.stdout, terminal: false });

	// pi stdout -> WebSocket
	rl.on("line", (line) => {
		if (ws.readyState === ws.OPEN) {
			ws.send(line);
		}
	});

	// WebSocket -> pi stdin
	ws.on("message", (data) => {
		if (pi.stdin?.writable) {
			pi.stdin.write(`${data.toString()}\n`);
		}
	});

	ws.on("close", () => {
		console.error("[server] Client disconnected, killing pi process");
		rl.close();
		pi.kill("SIGTERM");
		setTimeout(() => pi.kill("SIGKILL"), 2000);
	});

	ws.on("error", (err) => {
		console.error("[server] WebSocket error:", err.message);
	});

	pi.on("exit", (code) => {
		console.error(`[server] pi process exited with code ${code}`);
		rl.close();
		if (ws.readyState === ws.OPEN) {
			ws.close(4003, "Agent process exited");
		}
	});

	pi.on("error", (err) => {
		console.error("[server] Failed to spawn pi process:", err.message);
		if (ws.readyState === ws.OPEN) {
			ws.close(4002, "Failed to start agent process");
		}
	});
}

function main(): void {
	const options = parseArgs(process.argv);
	let activeWs: WebSocket | null = null;

	const server = http.createServer((req, res) => {
		if (options.staticDir) {
			serveStatic(options.staticDir, req, res);
		} else {
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("Pi Coding Agent WebSocket Server\n\nConnect via WebSocket.");
		}
	});

	const wss = new WebSocketServer({ server });

	wss.on("connection", (ws) => {
		if (activeWs) {
			ws.close(4001, "Another client is already connected");
			return;
		}

		activeWs = ws;
		console.error("[server] Client connected");

		bridgeConnection(ws, options.piCommand, options.piArgs);

		ws.on("close", () => {
			activeWs = null;
		});
	});

	server.listen(options.port, () => {
		console.error(`[server] Listening on http://localhost:${options.port}`);
		console.error(`[server] WebSocket: ws://localhost:${options.port}`);
		console.error(`[server] Pi command: ${options.piCommand} --mode rpc ${options.piArgs.join(" ")}`);
		if (options.staticDir) {
			console.error(`[server] Static files: ${options.staticDir}`);
		}
	});
}

main();
