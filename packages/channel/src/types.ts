export interface ChannelMeta {
	[key: string]: string;
}

export interface ChannelInboundEvent {
	channelId: string;
	source: string;
	content: string;
	meta?: ChannelMeta;
}

export interface ChannelReplyRecord {
	sequence: number;
	channelId: string;
	text: string;
	threadId?: string;
	meta?: ChannelMeta;
	sessionId?: string;
	timestamp: string;
}

export interface ChannelEventRecord extends ChannelInboundEvent {
	timestamp: string;
}

export interface ChannelState {
	channelId: string;
	pendingCount: number;
	started: boolean;
}

export interface ChannelBridgeOptions {
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

export interface ChannelEventAck {
	ok: boolean;
	error?: string;
	accepted?: boolean;
	queued?: boolean;
}

export interface BridgeState {
	host: string;
	port: number;
	channelCount: number;
	channels: ChannelState[];
}

export interface BridgeReadyPayload extends BridgeState {
	ok: true;
}

export interface SubscribeRequest {
	channelId: string;
}

export interface InternalReplyPayload {
	channelId: string;
	text: string;
	threadId?: string;
	meta?: ChannelMeta;
	sessionId?: string;
}
