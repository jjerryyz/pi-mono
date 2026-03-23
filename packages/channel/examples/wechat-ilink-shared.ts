/// <reference path="./qrcode-terminal.d.ts" />

import crypto from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import qrcode from "qrcode-terminal";

export const CHANNEL_VERSION = "0.1.0";
export const WECHAT_BASE_URL = process.env.WECHAT_ILINK_BASE_URL ?? "https://ilinkai.weixin.qq.com";
export const DEFAULT_STATE_DIR = join(homedir(), ".pi-channel", "wechat");
export const DEFAULT_ACCOUNT_FILE = join(DEFAULT_STATE_DIR, "account.json");
export const CLAUDE_ACCOUNT_FILE = join(homedir(), ".claude", "channels", "wechat", "account.json");
export const ACCOUNT_FILE = resolveAccountFile();
export const STATE_DIR = process.env.WECHAT_STATE_DIR ?? dirname(ACCOUNT_FILE);
export const SYNC_BUF_FILE = process.env.WECHAT_SYNC_BUF_FILE ?? join(STATE_DIR, "sync-buf.txt");

const BOT_TYPE = "3";
const LONG_POLL_TIMEOUT_MS = 35_000;
const QR_STATUS_TIMEOUT_MS = 35_000;
const QR_LOGIN_DEADLINE_MS = 480_000;
const CONFIG_TIMEOUT_MS = 10_000;

const MSG_TYPE_USER = 1;
const MSG_TYPE_BOT = 2;
const MSG_STATE_PROCESSING = 1;
const MSG_STATE_FINISH = 2;
const MSG_ITEM_TEXT = 1;
const MSG_ITEM_VOICE = 3;
const TYPING_STATUS_PROCESSING = 1;
const TYPING_STATUS_CANCEL = 2;

export interface AccountData {
	token: string;
	baseUrl: string;
	accountId: string;
	userId?: string;
	savedAt: string;
}

interface QRCodeResponse {
	qrcode: string;
	qrcode_img_content: string;
}

interface QRStatusResponse {
	status: "wait" | "scaned" | "confirmed" | "expired";
	bot_token?: string;
	ilink_bot_id?: string;
	baseurl?: string;
	ilink_user_id?: string;
}

interface TextItem {
	text?: string;
}

interface RefMessage {
	title?: string;
}

interface MessageItem {
	type?: number;
	text_item?: TextItem;
	voice_item?: { text?: string };
	ref_msg?: RefMessage;
}

export interface WeixinMessage {
	from_user_id?: string;
	session_id?: string;
	message_type?: number;
	item_list?: MessageItem[];
	context_token?: string;
}

export interface GetUpdatesResp {
	ret?: number;
	errcode?: number;
	errmsg?: string;
	msgs?: WeixinMessage[];
	get_updates_buf?: string;
}

interface GetConfigResp {
	ret?: number;
	errmsg?: string;
	typing_ticket?: string;
}

function log(message: string): void {
	console.log(`[wechat] ${message}`);
}

function logError(message: string): void {
	console.error(`[wechat] ${message}`);
}

function resolveAccountFile(): string {
	const configured = process.env.WECHAT_ACCOUNT_FILE?.trim();
	if (configured) {
		return configured;
	}
	if (existsSync(DEFAULT_ACCOUNT_FILE)) {
		return DEFAULT_ACCOUNT_FILE;
	}
	if (existsSync(CLAUDE_ACCOUNT_FILE)) {
		return CLAUDE_ACCOUNT_FILE;
	}
	return DEFAULT_ACCOUNT_FILE;
}

function ensureDir(dir: string): void {
	mkdirSync(dir, { recursive: true });
}

export function saveAccount(account: AccountData): void {
	ensureDir(dirname(ACCOUNT_FILE));
	writeFileSync(ACCOUNT_FILE, JSON.stringify(account, null, 2), "utf-8");
	try {
		chmodSync(ACCOUNT_FILE, 0o600);
	} catch {
		// best effort
	}
}

export function loadAccountFromEnv(): AccountData | null {
	const envToken = process.env.WECHAT_ILINK_TOKEN?.trim();
	if (!envToken) {
		return null;
	}

	return {
		token: envToken,
		baseUrl: WECHAT_BASE_URL,
		accountId: process.env.WECHAT_ILINK_ACCOUNT_ID?.trim() || "env-account",
		...(process.env.WECHAT_ILINK_USER_ID?.trim() ? { userId: process.env.WECHAT_ILINK_USER_ID.trim() } : {}),
		savedAt: new Date().toISOString(),
	};
}

export function loadSavedAccount(): AccountData | null {
	if (!existsSync(ACCOUNT_FILE)) {
		return null;
	}

	return JSON.parse(readFileSync(ACCOUNT_FILE, "utf-8")) as AccountData;
}

export function randomWechatUin(): string {
	const uint32 = crypto.randomBytes(4).readUInt32BE(0);
	return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(token: string, body: string): Record<string, string> {
	return {
		"Content-Type": "application/json",
		AuthorizationType: "ilink_bot_token",
		Authorization: `Bearer ${token}`,
		"X-WECHAT-UIN": randomWechatUin(),
		"Content-Length": String(Buffer.byteLength(body, "utf-8")),
	};
}

async function apiFetch(params: {
	baseUrl: string;
	endpoint: string;
	token: string;
	body: string;
	timeoutMs: number;
}): Promise<string> {
	const base = params.baseUrl.endsWith("/") ? params.baseUrl : `${params.baseUrl}/`;
	const url = new URL(params.endpoint, base).toString();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), params.timeoutMs);

	try {
		const response = await fetch(url, {
			method: "POST",
			headers: buildHeaders(params.token, params.body),
			body: params.body,
			signal: controller.signal,
		});
		const text = await response.text();
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${text}`);
		}
		return text;
	} finally {
		clearTimeout(timer);
	}
}

async function fetchQrCode(baseUrl: string): Promise<QRCodeResponse> {
	const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
	const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`, base).toString();
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`QR fetch failed: ${response.status}`);
	}
	return (await response.json()) as QRCodeResponse;
}

async function pollQrStatus(baseUrl: string, qrCode: string): Promise<QRStatusResponse> {
	const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
	const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrCode)}`, base).toString();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), QR_STATUS_TIMEOUT_MS);

	try {
		const response = await fetch(url, {
			headers: { "iLink-App-ClientVersion": "1" },
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`QR status failed: ${response.status}`);
		}
		return (await response.json()) as QRStatusResponse;
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			return { status: "wait" };
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

export async function doQrLogin(baseUrl = WECHAT_BASE_URL): Promise<AccountData | null> {
	log("No saved WeChat credentials found. Starting QR login...");
	const qr = await fetchQrCode(baseUrl);

	log("Scan this QR code with WeChat:");
	await new Promise<void>((resolve) => {
		qrcode.generate(qr.qrcode_img_content, { small: true }, (output) => {
			process.stdout.write(`${output}\n`);
			resolve();
		});
	});

	log("Waiting for scan and confirmation...");
	const deadline = Date.now() + QR_LOGIN_DEADLINE_MS;
	let scannedPrinted = false;

	while (Date.now() < deadline) {
		const status = await pollQrStatus(baseUrl, qr.qrcode);
		switch (status.status) {
			case "wait":
				break;
			case "scaned":
				if (!scannedPrinted) {
					log("QR scanned. Confirm in WeChat...");
					scannedPrinted = true;
				}
				break;
			case "expired":
				logError("QR code expired.");
				return null;
			case "confirmed": {
				if (!status.ilink_bot_id || !status.bot_token) {
					logError("Login confirmed but bot details were incomplete.");
					return null;
				}

				const account: AccountData = {
					token: status.bot_token,
					baseUrl: status.baseurl || baseUrl,
					accountId: status.ilink_bot_id,
					...(status.ilink_user_id ? { userId: status.ilink_user_id } : {}),
					savedAt: new Date().toISOString(),
				};
				saveAccount(account);
				log(`Saved credentials to ${ACCOUNT_FILE}`);
				return account;
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}

	logError("QR login timed out.");
	return null;
}

export function extractTextFromMessage(message: WeixinMessage): string {
	for (const item of message.item_list ?? []) {
		if (item.type === MSG_ITEM_TEXT && item.text_item?.text) {
			if (!item.ref_msg?.title) {
				return item.text_item.text;
			}
			return `[引用: ${item.ref_msg.title}]\n${item.text_item.text}`;
		}
		if (item.type === MSG_ITEM_VOICE && item.voice_item?.text) {
			return item.voice_item.text;
		}
	}
	return "";
}

export async function getUpdates(account: AccountData, getUpdatesBuf: string): Promise<GetUpdatesResp> {
	try {
		const raw = await apiFetch({
			baseUrl: account.baseUrl,
			endpoint: "ilink/bot/getupdates",
			token: account.token,
			body: JSON.stringify({
				get_updates_buf: getUpdatesBuf,
				base_info: { channel_version: CHANNEL_VERSION },
			}),
			timeoutMs: LONG_POLL_TIMEOUT_MS,
		});
		return JSON.parse(raw) as GetUpdatesResp;
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
		}
		throw error;
	}
}

function generateClientId(): string {
	return `pi-channel-wechat:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

export async function sendWechatText(
	account: AccountData,
	toUserId: string,
	text: string,
	contextToken: string,
): Promise<void> {
	await apiFetch({
		baseUrl: account.baseUrl,
		endpoint: "ilink/bot/sendmessage",
		token: account.token,
		body: JSON.stringify({
			msg: {
				from_user_id: "",
				to_user_id: toUserId,
				client_id: generateClientId(),
				message_type: MSG_TYPE_BOT,
				message_state: MSG_STATE_FINISH,
				item_list: [{ type: MSG_ITEM_TEXT, text_item: { text } }],
				context_token: contextToken,
			},
			base_info: { channel_version: CHANNEL_VERSION },
		}),
		timeoutMs: 15_000,
	});
}

export async function sendWechatProcessing(
	account: AccountData,
	toUserId: string,
	contextToken: string,
	text = "思考中...",
): Promise<void> {
	await apiFetch({
		baseUrl: account.baseUrl,
		endpoint: "ilink/bot/sendmessage",
		token: account.token,
		body: JSON.stringify({
			msg: {
				from_user_id: "",
				to_user_id: toUserId,
				client_id: generateClientId(),
				message_type: MSG_TYPE_BOT,
				message_state: MSG_STATE_PROCESSING,
				item_list: [{ type: MSG_ITEM_TEXT, text_item: { text } }],
				context_token: contextToken,
			},
			base_info: { channel_version: CHANNEL_VERSION },
		}),
		timeoutMs: 15_000,
	});
}

export async function getWechatTypingTicket(
	account: AccountData,
	toUserId: string,
	contextToken?: string,
): Promise<string | undefined> {
	const raw = await apiFetch({
		baseUrl: account.baseUrl,
		endpoint: "ilink/bot/getconfig",
		token: account.token,
		body: JSON.stringify({
			ilink_user_id: toUserId,
			context_token: contextToken,
			base_info: { channel_version: CHANNEL_VERSION },
		}),
		timeoutMs: CONFIG_TIMEOUT_MS,
	});
	const response = JSON.parse(raw) as GetConfigResp;
	if ((response.ret ?? 0) !== 0) {
		throw new Error(`getconfig failed: ret=${response.ret ?? "?"} errmsg=${response.errmsg ?? ""}`);
	}
	const typingTicket = response.typing_ticket?.trim();
	return typingTicket ? typingTicket : undefined;
}

async function sendWechatTyping(
	account: AccountData,
	toUserId: string,
	typingTicket: string,
	status: number,
): Promise<void> {
	await apiFetch({
		baseUrl: account.baseUrl,
		endpoint: "ilink/bot/sendtyping",
		token: account.token,
		body: JSON.stringify({
			ilink_user_id: toUserId,
			typing_ticket: typingTicket,
			status,
			base_info: { channel_version: CHANNEL_VERSION },
		}),
		timeoutMs: CONFIG_TIMEOUT_MS,
	});
}

export async function startWechatTyping(
	account: AccountData,
	toUserId: string,
	typingTicket: string,
): Promise<void> {
	await sendWechatTyping(account, toUserId, typingTicket, TYPING_STATUS_PROCESSING);
}

export async function stopWechatTyping(
	account: AccountData,
	toUserId: string,
	typingTicket: string,
): Promise<void> {
	await sendWechatTyping(account, toUserId, typingTicket, TYPING_STATUS_CANCEL);
}

export { MSG_TYPE_USER };
