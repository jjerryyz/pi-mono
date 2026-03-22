import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChannelEventRecord, ChannelReplyRecord } from "./types.js";

function encodeChannelId(channelId: string): string {
	return encodeURIComponent(channelId);
}

function ensureDir(dir: string): void {
	mkdirSync(dir, { recursive: true });
}

function readJsonl<T>(path: string): T[] {
	if (!existsSync(path)) {
		return [];
	}

	const content = readFileSync(path, "utf-8");
	if (!content.trim()) {
		return [];
	}

	const result: T[] = [];
	for (const line of content.split(/\r?\n/)) {
		if (!line.trim()) {
			continue;
		}
		result.push(JSON.parse(line) as T);
	}
	return result;
}

async function appendJsonl(path: string, value: unknown): Promise<void> {
	await appendFile(path, `${JSON.stringify(value)}\n`, "utf-8");
}

export class ChannelStore {
	private readonly channelsDir: string;
	private readonly sessionsDir: string;
	private readonly nextReplySequence = new Map<string, number>();

	constructor(dataDir: string) {
		this.channelsDir = join(dataDir, "channels");
		this.sessionsDir = join(dataDir, "sessions");
		ensureDir(this.channelsDir);
		ensureDir(this.sessionsDir);
	}

	getChannelDir(channelId: string): string {
		const dir = join(this.channelsDir, encodeChannelId(channelId));
		ensureDir(dir);
		return dir;
	}

	getSessionDir(channelId: string): string {
		const dir = join(this.sessionsDir, encodeChannelId(channelId));
		ensureDir(dir);
		return dir;
	}

	getInboundLogPath(channelId: string): string {
		return join(this.getChannelDir(channelId), "inbound.jsonl");
	}

	getReplyLogPath(channelId: string): string {
		return join(this.getChannelDir(channelId), "replies.jsonl");
	}

	async logInbound(record: ChannelEventRecord): Promise<void> {
		await appendJsonl(this.getInboundLogPath(record.channelId), record);
	}

	async logReply(
		reply: Omit<ChannelReplyRecord, "sequence" | "timestamp"> & { timestamp?: string },
	): Promise<ChannelReplyRecord> {
		const sequence = this.getNextReplySequence(reply.channelId);
		const record: ChannelReplyRecord = {
			sequence,
			channelId: reply.channelId,
			text: reply.text,
			...(reply.threadId ? { threadId: reply.threadId } : {}),
			...(reply.meta ? { meta: reply.meta } : {}),
			...(reply.sessionId ? { sessionId: reply.sessionId } : {}),
			timestamp: reply.timestamp ?? new Date().toISOString(),
		};
		await appendJsonl(this.getReplyLogPath(reply.channelId), record);
		this.nextReplySequence.set(reply.channelId, sequence + 1);
		return record;
	}

	getReplies(channelId: string, after = 0): ChannelReplyRecord[] {
		return readJsonl<ChannelReplyRecord>(this.getReplyLogPath(channelId)).filter((reply) => reply.sequence > after);
	}

	private getNextReplySequence(channelId: string): number {
		const cached = this.nextReplySequence.get(channelId);
		if (cached !== undefined) {
			return cached;
		}

		const existing = this.getReplies(channelId, 0);
		const next = existing.length > 0 ? existing[existing.length - 1].sequence + 1 : 1;
		this.nextReplySequence.set(channelId, next);
		return next;
	}
}

export function ensureDataDir(dataDir: string): void {
	ensureDir(dataDir);
	const gitignorePath = join(dataDir, ".gitignore");
	if (!existsSync(gitignorePath)) {
		writeFileSync(gitignorePath, "*\n!.gitignore\n", "utf-8");
	}
}
