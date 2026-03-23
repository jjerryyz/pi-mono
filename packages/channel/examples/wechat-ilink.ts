#!/usr/bin/env npx tsx

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
	ACCOUNT_FILE,
	type AccountData,
	extractTextFromMessage,
	getUpdates,
	loadAccountFromEnv,
	loadSavedAccount,
	MSG_TYPE_USER,
	type WeixinMessage,
	sendWechatText,
	STATE_DIR,
	SYNC_BUF_FILE,
} from "./wechat-ilink-shared.js";

const PI_CHANNEL_URL = process.env.PI_CHANNEL_URL ?? "http://127.0.0.1:8788";
const POLL_INTERVAL_MS = 2_000;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;

interface ChannelEventAck {
	ok: boolean;
	error?: string;
}

interface ChannelReplyRecord {
	sequence: number;
	channelId: string;
	text: string;
	timestamp: string;
}

interface GetRepliesResponse {
	ok: boolean;
	replies?: ChannelReplyRecord[];
}

interface ReplyState {
	after: number;
	polling: boolean;
	pendingRuns: number;
	priming: Promise<void> | null;
	timer: ReturnType<typeof setInterval> | null;
}

const contextTokenCache = new Map<string, string>();
const replyStates = new Map<string, ReplyState>();

function log(message: string): void {
	console.log(`[wechat] ${message}`);
}

function logError(message: string): void {
	console.error(`[wechat] ${message}`);
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
	const data = (await response.json()) as GetRepliesResponse;
	return data.replies ?? [];
}

function getOrCreateReplyState(senderId: string): ReplyState {
	const existing = replyStates.get(senderId);
	if (existing) {
		return existing;
	}

	const state: ReplyState = {
		after: 0,
		polling: false,
		pendingRuns: 0,
		priming: null,
		timer: null,
	};
	replyStates.set(senderId, state);
	return state;
}

async function ensureIntermediateState(
	_account: AccountData,
	_senderId: string,
	_contextToken: string,
	_state: ReplyState,
): Promise<void> {
	return;
}

async function clearIntermediateState(_account: AccountData, _senderId: string, _state: ReplyState): Promise<void> {
	return;
}

async function primeReplyCursor(senderId: string, state: ReplyState): Promise<void> {
	if (!state.priming) {
		state.priming = (async () => {
			const replies = await fetchReplies(senderId, 0);
			for (const reply of replies) {
				state.after = Math.max(state.after, reply.sequence);
			}
		})().finally(() => {
			state.priming = null;
		});
	}
	await state.priming;
}

async function pollReplies(account: AccountData, senderId: string, state: ReplyState): Promise<void> {
	if (state.polling) {
		return;
	}

	const contextToken = contextTokenCache.get(senderId);
	if (!contextToken) {
		return;
	}

	state.polling = true;
	try {
		const replies = await fetchReplies(senderId, state.after);
		if (replies.length > 0) {
			state.pendingRuns = Math.max(0, state.pendingRuns - 1);
			await clearIntermediateState(account, senderId, state);
			log(`delivering ${replies.length} ${replies.length === 1 ? "reply" : "replies"} to ${senderId}`);
		}
		for (const reply of replies) {
			await sendWechatText(account, senderId, reply.text, contextToken);
			state.after = Math.max(state.after, reply.sequence);
		}
		if (state.pendingRuns > 0) {
			void ensureIntermediateState(account, senderId, contextToken, state).catch((error) => {
				logError(`failed to resume intermediate state for ${senderId}: ${error instanceof Error ? error.message : String(error)}`);
			});
		}
	} catch (error) {
		logError(`reply poll failed for ${senderId}: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		state.polling = false;
	}
}

function ensureReplyPoller(account: AccountData, senderId: string): void {
	const state = getOrCreateReplyState(senderId);
	if (state.timer) {
		return;
	}

	state.timer = setInterval(() => {
		void pollReplies(account, senderId, state);
	}, POLL_INTERVAL_MS);
	void pollReplies(account, senderId, state);
}

async function forwardMessage(account: AccountData, message: WeixinMessage, text: string): Promise<void> {
	const senderId = message.from_user_id;
	if (!senderId) {
		return;
	}

	if (message.context_token) {
		contextTokenCache.set(senderId, message.context_token);
	}

	const state = getOrCreateReplyState(senderId);
	await primeReplyCursor(senderId, state);

	const ack = await sendChannelEvent({
		channelId: senderId,
		source: "wechat",
		content: text,
		meta: {
			sender: senderId.split("@")[0] || senderId,
			sender_id: senderId,
			...(message.session_id ? { session_id: message.session_id } : {}),
		},
	});

	if (!ack.ok) {
		logError(`bridge rejected message from ${senderId}: ${ack.error ?? "unknown error"}`);
		return;
	}

	const contextToken = contextTokenCache.get(senderId);
	if (contextToken) {
		state.pendingRuns++;
		void ensureIntermediateState(account, senderId, contextToken, state).catch((error) => {
			logError(`failed to show intermediate state for ${senderId}: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	log(`queued message from ${senderId}; pending runs=${state.pendingRuns}`);
	ensureReplyPoller(account, senderId);
}

async function startLongPoll(account: AccountData): Promise<never> {
	mkdirSync(STATE_DIR, { recursive: true });

	let getUpdatesBuf = "";
	if (existsSync(SYNC_BUF_FILE)) {
		getUpdatesBuf = readFileSync(SYNC_BUF_FILE, "utf-8");
	}

	let consecutiveFailures = 0;
	log(`listening for WeChat messages as ${account.accountId}`);

	while (true) {
		try {
			const response = await getUpdates(account, getUpdatesBuf);
			const hasError = (response.ret !== undefined && response.ret !== 0) ||
				(response.errcode !== undefined && response.errcode !== 0);
			if (hasError) {
				consecutiveFailures++;
				logError(
					`getupdates failed: ret=${response.ret ?? "?"} errcode=${response.errcode ?? "?"} errmsg=${response.errmsg ?? ""}`,
				);
				await new Promise((resolve) =>
					setTimeout(resolve, consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS),
				);
				if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
					consecutiveFailures = 0;
				}
				continue;
			}

			consecutiveFailures = 0;
			if (response.get_updates_buf) {
				getUpdatesBuf = response.get_updates_buf;
				writeFileSync(SYNC_BUF_FILE, getUpdatesBuf, "utf-8");
			}

			for (const message of response.msgs ?? []) {
				if (message.message_type !== MSG_TYPE_USER) {
					continue;
				}

				const text = extractTextFromMessage(message);
				if (!text.trim()) {
					continue;
				}

				log(`message from ${message.from_user_id ?? "unknown"}: ${text.slice(0, 80)}`);
				await forwardMessage(account, message, text);
			}
		} catch (error) {
			consecutiveFailures++;
			logError(`poll failed: ${error instanceof Error ? error.message : String(error)}`);
			await new Promise((resolve) =>
				setTimeout(resolve, consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS),
			);
			if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
				consecutiveFailures = 0;
			}
		}
	}
}

function getAccount(): AccountData {
	const envAccount = loadAccountFromEnv();
	if (envAccount) {
		return envAccount;
	}

	const savedAccount = loadSavedAccount();
	if (savedAccount) {
		return savedAccount;
	}

	throw new Error(
		`No WeChat credentials found. Run "npx tsx examples/wechat-setup.ts" or set WECHAT_ILINK_TOKEN. Expected ${ACCOUNT_FILE}.`,
	);
}

async function main(): Promise<void> {
	const account = getAccount();

	try {
		await fetch(`${PI_CHANNEL_URL}/health`);
	} catch {
		logError(`pi-channel bridge not reachable at ${PI_CHANNEL_URL}`);
		process.exit(1);
	}

	log(`using WeChat account ${account.accountId}`);
	log(`account source: ${process.env.WECHAT_ILINK_TOKEN ? "env" : ACCOUNT_FILE}`);
	await startLongPoll(account);
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
	logError(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
