/**
 * Pi Coding Agent Web Frontend
 *
 * Connects to a coding-agent WebSocket server and provides a web UI
 * for interacting with the agent.
 */

import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { ChatPanel } from "@mariozechner/pi-web-ui";
import { html, render } from "lit";
import { AlertCircle, ChevronsUpDown, Loader, Plus, Wifi, WifiOff } from "lucide";
import "./app.css";
import { RemoteAgent } from "./remote-agent.js";
import { getBashRenderer, registerCodingAgentRenderers, setRemoteAgent } from "./renderers/index.js";
import { type RpcExtensionUIRequest, WsRpcClient } from "./ws-rpc-client.js";

// ============================================================================
// State
// ============================================================================

let client: WsRpcClient;
let agent: RemoteAgent;
let chatPanel: ChatPanel;
let connected = false;
let connectionError = "";
let agentUnsubscribe: (() => void) | undefined;

// ============================================================================
// WebSocket URL
// ============================================================================

function getWsUrl(): string {
	const params = new URLSearchParams(window.location.search);
	const urlParam = params.get("ws");
	if (urlParam) return urlParam;

	// Default: connect to the coding-agent server on port 3001
	return "ws://localhost:3001";
}

// ============================================================================
// Extension UI Request Handler
// ============================================================================

async function handleExtensionUIRequest(request: RpcExtensionUIRequest): Promise<void> {
	switch (request.method) {
		case "notify": {
			const msg = request.message as string;
			const type = (request.notifyType as string) || "info";
			console.log(`[${type}] ${msg}`);
			break;
		}

		case "confirm": {
			const confirmed = window.confirm(`${request.title}\n\n${request.message}`);
			client.sendExtensionUIResponse({
				type: "extension_ui_response",
				id: request.id,
				confirmed,
			});
			break;
		}

		case "select": {
			const options = request.options as string[];
			const choice = window.prompt(
				`${request.title}\n\nOptions:\n${options.map((o, i) => `${i + 1}. ${o}`).join("\n")}\n\nEnter number:`,
			);
			if (choice) {
				const idx = parseInt(choice, 10) - 1;
				if (idx >= 0 && idx < options.length) {
					client.sendExtensionUIResponse({
						type: "extension_ui_response",
						id: request.id,
						value: options[idx],
					});
					return;
				}
			}
			client.sendExtensionUIResponse({
				type: "extension_ui_response",
				id: request.id,
				cancelled: true,
			});
			break;
		}

		case "input": {
			const value = window.prompt(request.title as string, (request.placeholder as string) || "");
			if (value !== null) {
				client.sendExtensionUIResponse({
					type: "extension_ui_response",
					id: request.id,
					value,
				});
			} else {
				client.sendExtensionUIResponse({
					type: "extension_ui_response",
					id: request.id,
					cancelled: true,
				});
			}
			break;
		}

		case "setTitle": {
			document.title = `Pi - ${request.title}`;
			break;
		}

		default:
			break;
	}
}

// ============================================================================
// Connection
// ============================================================================

async function connect(): Promise<void> {
	const wsUrl = getWsUrl();
	connectionError = "";
	renderApp();

	try {
		client = new WsRpcClient();

		client.onConnectionChange((isConnected) => {
			connected = isConnected;
			if (!isConnected) {
				connectionError = "Disconnected from server";
			}
			renderApp();
		});

		client.onExtensionUIRequest((request) => {
			handleExtensionUIRequest(request);
		});

		await client.connect(wsUrl);
		connected = true;

		// Create the RemoteAgent adapter
		agent = new RemoteAgent({ client });
		setRemoteAgent(agent);
		await agent.init();

		// Subscribe to agent events for re-rendering and bash streaming
		if (agentUnsubscribe) agentUnsubscribe();
		agentUnsubscribe = agent.subscribe((event: AgentEvent) => {
			if (event.type === "tool_execution_start") {
				const e = event as any;
				if (e.toolName === "bash") {
					getBashRenderer().setToolCallId(e.toolCallId);
				}
			}
			renderApp();
		});

		// Set up ChatPanel
		chatPanel = new ChatPanel();
		await chatPanel.setAgent(agent as any, {
			onApiKeyRequired: async (_provider: string) => {
				// Server handles API keys
				return true;
			},
		});

		renderApp();
	} catch (err: any) {
		connectionError = err.message || "Failed to connect";
		connected = false;
		renderApp();
	}
}

// ============================================================================
// Render
// ============================================================================

function renderApp(): void {
	const app = document.getElementById("app");
	if (!app) return;

	if (!connected || !chatPanel) {
		render(renderConnectionScreen(), app);
		return;
	}

	const appHtml = html`
		<div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden">
			<!-- Header -->
			<div class="flex items-center justify-between border-b border-border shrink-0 px-4 py-1">
				<div class="flex items-center gap-2">
					<span class="text-sm font-semibold text-foreground">Pi Coding Agent</span>
					<span class="inline-flex items-center gap-1 text-xs ${connected ? "text-green-600 dark:text-green-400" : "text-destructive"}">
						${icon(connected ? Wifi : WifiOff, "xs")}
						${connected ? "Connected" : "Disconnected"}
					</span>
					${
						agent?.isCompacting
							? html`<span class="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
							${icon(Loader, "xs")} Compacting...
						</span>`
							: ""
					}
					${
						agent?.retryState
							? html`<span class="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
							${icon(AlertCircle, "xs")} Retry ${agent.retryState.attempt}/${agent.retryState.maxAttempts}
						</span>`
							: ""
					}
				</div>
				<div class="flex items-center gap-1">
					${Button({
						variant: "ghost",
						size: "sm",
						children: html`${icon(Plus, "sm")}`,
						onClick: async () => {
							if (agent) {
								await agent.newSession();
								renderApp();
							}
						},
						title: "New Session",
					})}
					${Button({
						variant: "ghost",
						size: "sm",
						children: html`${icon(ChevronsUpDown, "sm")}`,
						onClick: async () => {
							if (agent) {
								await agent.compact();
							}
						},
						title: "Compact Context",
					})}
					<theme-toggle></theme-toggle>
				</div>
			</div>

			<!-- Chat Panel -->
			${chatPanel}
		</div>
	`;

	render(appHtml, app);
}

function renderConnectionScreen() {
	return html`
		<div class="w-full h-screen flex items-center justify-center bg-background text-foreground">
			<div class="flex flex-col items-center gap-4 max-w-md text-center p-8">
				<h1 class="text-xl font-semibold">Pi Coding Agent</h1>
				${
					connectionError
						? html`
						<div class="flex items-center gap-2 text-destructive text-sm">
							${icon(AlertCircle, "sm")}
							<span>${connectionError}</span>
						</div>
						<p class="text-sm text-muted-foreground">
							Make sure the coding agent server is running:<br/>
							<code class="bg-secondary px-2 py-1 rounded text-xs mt-1 inline-block">pi --mode server --port 3001</code>
						</p>
						${Button({
							variant: "default",
							size: "sm",
							children: "Retry Connection",
							onClick: () => connect(),
						})}
					`
						: html`
						<div class="flex items-center gap-2 text-muted-foreground text-sm">
							${icon(Loader, "sm")}
							<span>Connecting to server...</span>
						</div>
					`
				}
			</div>
		</div>
	`;
}

// ============================================================================
// Init
// ============================================================================

registerCodingAgentRenderers();
connect();
