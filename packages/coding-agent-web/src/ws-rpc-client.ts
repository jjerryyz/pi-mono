/**
 * WebSocket RPC client for communicating with the coding agent server.
 *
 * Speaks the same JSON protocol as the stdin/stdout RPC mode,
 * with each message as a WebSocket text frame.
 */

/** Minimal RPC command shape (client -> server) */
export interface RpcCommand {
	id?: string;
	type: string;
	[key: string]: unknown;
}

/** RPC response (server -> client) */
export interface RpcResponse {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
}

/** Extension UI request (server -> client) */
export interface RpcExtensionUIRequest {
	type: "extension_ui_request";
	id: string;
	method: string;
	[key: string]: unknown;
}

/** Extension UI response (client -> server) */
export interface RpcExtensionUIResponse {
	type: "extension_ui_response";
	id: string;
	[key: string]: unknown;
}

export type WsRpcEventListener = (event: Record<string, unknown>) => void;
export type WsRpcExtensionUIListener = (request: RpcExtensionUIRequest) => void;
export type WsRpcConnectionListener = (connected: boolean) => void;

/**
 * Browser WebSocket client that speaks the RPC protocol.
 *
 * Mirrors the RpcClient from coding-agent but uses browser WebSocket
 * instead of child process stdin/stdout.
 */
export class WsRpcClient {
	private ws: WebSocket | null = null;
	private eventListeners: WsRpcEventListener[] = [];
	private extensionUIListeners: WsRpcExtensionUIListener[] = [];
	private connectionListeners: WsRpcConnectionListener[] = [];
	private pendingRequests = new Map<string, { resolve: (r: RpcResponse) => void; reject: (e: Error) => void }>();
	private requestId = 0;
	private _connected = false;

	get connected(): boolean {
		return this._connected;
	}

	connect(url: string): Promise<void> {
		return new Promise((resolve, reject) => {
			if (this.ws) {
				this.disconnect();
			}

			this.ws = new WebSocket(url);

			this.ws.onopen = () => {
				this._connected = true;
				for (const listener of this.connectionListeners) listener(true);
				resolve();
			};

			this.ws.onerror = (_ev) => {
				if (!this._connected) {
					reject(new Error("WebSocket connection failed"));
				}
			};

			this.ws.onclose = () => {
				this._connected = false;
				for (const listener of this.connectionListeners) listener(false);
				// Reject all pending requests
				for (const [, pending] of this.pendingRequests) {
					pending.reject(new Error("WebSocket closed"));
				}
				this.pendingRequests.clear();
				this.ws = null;
			};

			this.ws.onmessage = (ev) => {
				this.handleMessage(ev.data as string);
			};
		});
	}

	disconnect(): void {
		if (this.ws) {
			this.ws.close();
			this.ws = null;
			this._connected = false;
		}
	}

	/**
	 * Send an RPC command and wait for the correlated response.
	 */
	/**
	 * Send an RPC command and wait for the correlated response.
	 * Long-running commands (bash, compact) get extended timeouts.
	 */
	async send(command: RpcCommand): Promise<RpcResponse> {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			throw new Error("WebSocket not connected");
		}

		const id = `req_${++this.requestId}`;
		const fullCommand = { ...command, id };

		const longRunningCommands = new Set(["bash", "compact", "export_html"]);
		const timeoutMs = longRunningCommands.has(command.type) ? 300000 : 30000;

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Timeout waiting for response to ${command.type}`));
			}, timeoutMs);

			this.pendingRequests.set(id, {
				resolve: (response) => {
					clearTimeout(timeout);
					resolve(response);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			});

			this.ws!.send(JSON.stringify(fullCommand));
		});
	}

	/**
	 * Send a fire-and-forget message (no response expected).
	 */
	sendRaw(message: object): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(message));
		}
	}

	onEvent(listener: WsRpcEventListener): () => void {
		this.eventListeners.push(listener);
		return () => {
			const idx = this.eventListeners.indexOf(listener);
			if (idx !== -1) this.eventListeners.splice(idx, 1);
		};
	}

	onExtensionUIRequest(listener: WsRpcExtensionUIListener): () => void {
		this.extensionUIListeners.push(listener);
		return () => {
			const idx = this.extensionUIListeners.indexOf(listener);
			if (idx !== -1) this.extensionUIListeners.splice(idx, 1);
		};
	}

	onConnectionChange(listener: WsRpcConnectionListener): () => void {
		this.connectionListeners.push(listener);
		return () => {
			const idx = this.connectionListeners.indexOf(listener);
			if (idx !== -1) this.connectionListeners.splice(idx, 1);
		};
	}

	sendExtensionUIResponse(response: RpcExtensionUIResponse): void {
		this.sendRaw(response);
	}

	private handleMessage(data: string): void {
		try {
			const parsed = JSON.parse(data);

			// Response to a pending request
			if (parsed.type === "response" && parsed.id && this.pendingRequests.has(parsed.id)) {
				const pending = this.pendingRequests.get(parsed.id)!;
				this.pendingRequests.delete(parsed.id);
				pending.resolve(parsed as RpcResponse);
				return;
			}

			// Extension UI request from server
			if (parsed.type === "extension_ui_request") {
				for (const listener of this.extensionUIListeners) {
					listener(parsed as RpcExtensionUIRequest);
				}
				return;
			}

			// Agent event
			for (const listener of this.eventListeners) {
				listener(parsed);
			}
		} catch {
			// Ignore non-JSON messages
		}
	}
}
