#!/usr/bin/env npx tsx

import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;
const PI_CHANNEL_URL = process.env.PI_CHANNEL_URL ?? "http://127.0.0.1:8788";
const POLL_INTERVAL_MS = 2_000;

if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN) {
	console.error("SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set.");
	process.exit(1);
}

interface SlackUserProfile {
	userName?: string;
	displayName?: string;
}

interface ChannelEventAck {
	ok: boolean;
	error?: string;
}

interface ChannelReplyRecord {
	sequence: number;
	channelId: string;
	text: string;
	threadId?: string;
	meta?: Record<string, string>;
	timestamp: string;
}

interface ReplyState {
	after: number;
	polling: boolean;
	priming: Promise<void> | null;
	timer: ReturnType<typeof setInterval> | null;
}

type SlackMentionEvent = {
	text?: string;
	channel: string;
	user: string;
	ts: string;
	thread_ts?: string;
};

type SlackMessageEvent = {
	text?: string;
	channel: string;
	user?: string;
	ts: string;
	thread_ts?: string;
	channel_type?: string;
	subtype?: string;
	bot_id?: string;
};

const socketClient = new SocketModeClient({ appToken: SLACK_APP_TOKEN });
const webClient = new WebClient(SLACK_BOT_TOKEN);

let botUserId: string | null = null;

const userCache = new Map<string, SlackUserProfile>();
const replyStates = new Map<string, ReplyState>();

function stripMentions(text: string): string {
	return text.replace(/<@[A-Z0-9]+>/gi, "").trim();
}

async function getUserProfile(userId: string): Promise<SlackUserProfile> {
	const cached = userCache.get(userId);
	if (cached) {
		return cached;
	}

	const response = await webClient.users.info({ user: userId });
	const profile: SlackUserProfile = {
		userName: response.user?.name,
		displayName: response.user?.real_name || response.user?.profile?.display_name || response.user?.name,
	};
	userCache.set(userId, profile);
	return profile;
}

async function sendChannelEvent(body: {
	channelId: string;
	source: string;
	content: string;
	meta?: Record<string, string>;
}): Promise<ChannelEventAck> {
	const response = await fetch(`${PI_CHANNEL_URL}/channel/event`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return (await response.json()) as ChannelEventAck;
}

async function fetchReplies(channelId: string, after: number): Promise<ChannelReplyRecord[]> {
	const url = `${PI_CHANNEL_URL}/channel/replies?channelId=${encodeURIComponent(channelId)}&after=${after}`;
	const response = await fetch(url);
	const data = (await response.json()) as { ok: boolean; replies?: ChannelReplyRecord[] };
	return data.replies ?? [];
}

function getOrCreateReplyState(channelId: string): ReplyState {
	const existing = replyStates.get(channelId);
	if (existing) {
		return existing;
	}

	const state: ReplyState = {
		after: 0,
		polling: false,
		priming: null,
		timer: null,
	};
	replyStates.set(channelId, state);
	return state;
}

async function primeReplyCursor(channelId: string, state: ReplyState): Promise<void> {
	if (!state.priming) {
		state.priming = (async () => {
			const replies = await fetchReplies(channelId, 0);
			for (const reply of replies) {
				state.after = Math.max(state.after, reply.sequence);
			}
		})().finally(() => {
			state.priming = null;
		});
	}
	await state.priming;
}

async function pollReplies(channelId: string, state: ReplyState): Promise<void> {
	if (state.polling) {
		return;
	}

	state.polling = true;
	try {
		const replies = await fetchReplies(channelId, state.after);
		for (const reply of replies) {
			await webClient.chat.postMessage({
				channel: channelId,
				text: reply.text,
				...(reply.threadId || reply.meta?.thread_ts ? { thread_ts: reply.threadId ?? reply.meta?.thread_ts } : {}),
			});
			state.after = Math.max(state.after, reply.sequence);
		}
	} catch (error) {
		console.error(`[slack] reply poll failed for ${channelId}:`, error instanceof Error ? error.message : String(error));
	} finally {
		state.polling = false;
	}
}

function ensureReplyPoller(channelId: string): void {
	const state = getOrCreateReplyState(channelId);
	if (state.timer) {
		return;
	}

	state.timer = setInterval(() => {
		void pollReplies(channelId, state);
	}, POLL_INTERVAL_MS);
	void pollReplies(channelId, state);
}

async function forwardToChannel(channelId: string, text: string, userId: string, threadTs?: string): Promise<void> {
	const state = getOrCreateReplyState(channelId);
	await primeReplyCursor(channelId, state);

	let profile: SlackUserProfile | undefined;
	try {
		profile = await getUserProfile(userId);
	} catch {
		profile = undefined;
	}

	const ack = await sendChannelEvent({
		channelId,
		source: "slack",
		content: text,
		meta: {
			sender_id: userId,
			...(profile?.userName ? { user_name: profile.userName } : {}),
			...(profile?.displayName ? { display_name: profile.displayName } : {}),
			...(threadTs ? { thread_ts: threadTs } : {}),
		},
	});

	if (!ack.ok) {
		console.error(`[slack] bridge rejected event for ${channelId}: ${ack.error ?? "unknown error"}`);
		return;
	}

	ensureReplyPoller(channelId);
}

function setupHandlers(): void {
	socketClient.on("app_mention", ({ event, ack }) => {
		void ack();

		const mention = event as SlackMentionEvent;
		if (mention.channel.startsWith("D")) {
			return;
		}

		const text = stripMentions(mention.text ?? "");
		if (!text) {
			return;
		}

		console.log(`[slack] mention in ${mention.channel}: ${text.slice(0, 80)}`);
		void forwardToChannel(mention.channel, text, mention.user, mention.thread_ts ?? mention.ts);
	});

	socketClient.on("message", ({ event, ack }) => {
		void ack();

		const message = event as SlackMessageEvent;
		if (message.bot_id || !message.user || message.user === botUserId) {
			return;
		}
		if (message.subtype !== undefined && message.subtype !== "file_share") {
			return;
		}
		if (message.channel_type !== "im") {
			return;
		}

		const text = stripMentions(message.text ?? "");
		if (!text) {
			return;
		}

		console.log(`[slack] dm from ${message.user}: ${text.slice(0, 80)}`);
		void forwardToChannel(message.channel, text, message.user, message.thread_ts ?? message.ts);
	});
}

async function main(): Promise<void> {
	const auth = await webClient.auth.test();
	botUserId = auth.user_id as string;

	try {
		await fetch(`${PI_CHANNEL_URL}/health`);
	} catch {
		console.error(`[slack] pi-channel bridge not reachable at ${PI_CHANNEL_URL}`);
		process.exit(1);
	}

	console.log(`[slack] authenticated as ${auth.user} (${botUserId})`);
	console.log(`[slack] forwarding events to ${PI_CHANNEL_URL}`);
	setupHandlers();
	await socketClient.start();
	console.log("[slack] connected to Slack Socket Mode");
}

function shutdown(): void {
	for (const state of replyStates.values()) {
		if (state.timer) {
			clearInterval(state.timer);
		}
	}
	process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
