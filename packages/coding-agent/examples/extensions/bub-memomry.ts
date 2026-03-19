/**
 * Bub Memomry Extension
 *
 * A pi extension inspired by Bub's tape-based memory model. It keeps a
 * structured, append-only JSONL tape per workspace + session, supports
 * searchable anchors/handoffs, and injects a compact recall block into the
 * system prompt before each agent run.
 *
 * The extension name intentionally follows the requested spelling: "bub-memomry".
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, ImageContent, ToolCall, ToolResultMessage, UserMessage } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	type ExtensionContext,
	formatSize,
	type Theme,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const EXTENSION_NAME = "bub-memomry";
const STORAGE_DIR = path.join(os.homedir(), ".pi", EXTENSION_NAME);
const TAPES_DIR = path.join(STORAGE_DIR, "tapes");
const ARCHIVE_DIR = path.join(STORAGE_DIR, "archive");
const MAX_AUTO_INJECT_CHARS = 4000;
const AUTO_CONTEXT_ENTRY_LIMIT = 12;
const DEFAULT_READ_LIMIT = 20;
const MAX_SEARCH_RESULTS = 20;
const MIN_FUZZY_QUERY_LENGTH = 3;
const MIN_FUZZY_SCORE = 0.72;
const MAX_FUZZY_CANDIDATES = 128;
const WORD_PATTERN = /[a-z0-9_/-]+/g;
const DATA_URL_PATTERN = /data:[^;]+;base64,[^"'`\s)]+/g;

type TapeEntryKind = "message" | "tool_call" | "tool_result" | "anchor" | "event";
type TapeMetaValue = string | number | boolean | null;
type TapeMeta = Record<string, TapeMetaValue>;

interface TapeEntry {
	id: number;
	kind: TapeEntryKind;
	timestamp: string;
	payload: Record<string, unknown>;
	meta?: TapeMeta;
}

interface TapeInfo {
	name: string;
	entries: number;
	anchors: number;
	lastAnchor?: string;
	entriesSinceLastAnchor: number;
	lastTokenUsage?: number;
}

interface SearchHit {
	entry: TapeEntry;
	score: number;
}

interface TruncatedText {
	text: string;
	truncated: boolean;
}

class TapeOverviewComponent {
	private readonly lines: string[];
	private readonly theme: Theme;
	private readonly onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(lines: string[], theme: Theme, onClose: () => void) {
		this.lines = lines;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const rendered: string[] = [];
		rendered.push("");
		rendered.push(truncateToWidth(this.theme.fg("accent", " Bub Memomry "), width));
		rendered.push("");
		for (const line of this.lines) {
			rendered.push(truncateToWidth(line, width));
		}
		rendered.push("");
		rendered.push(truncateToWidth(this.theme.fg("dim", "Press Escape to close"), width));
		rendered.push("");

		this.cachedWidth = width;
		this.cachedLines = rendered;
		return rendered;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

function ensureDirs(): void {
	fs.mkdirSync(TAPES_DIR, { recursive: true });
	fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
}

function shortHash(value: string): string {
	return createHash("md5").update(value).digest("hex").slice(0, 16);
}

function normalizePath(value: string): string {
	return path.resolve(value);
}

function getTapeName(ctx: ExtensionContext): string {
	const workspaceHash = shortHash(normalizePath(ctx.cwd));
	const sessionHash = shortHash(ctx.sessionManager.getSessionId());
	return `${workspaceHash}__${sessionHash}`;
}

function getTapePath(ctx: ExtensionContext): string {
	return path.join(TAPES_DIR, `${getTapeName(ctx)}.jsonl`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function redactDataUrls(text: string): string {
	return text.replace(DATA_URL_PATTERN, "[media]");
}

function sanitizeForStorage(value: unknown): unknown {
	if (typeof value === "string") {
		return redactDataUrls(value);
	}
	if (Array.isArray(value)) {
		return value.map((item) => sanitizeForStorage(item));
	}
	if (isRecord(value)) {
		const next: Record<string, unknown> = {};
		for (const [key, entryValue] of Object.entries(value)) {
			if (entryValue === undefined) continue;
			next[key] = sanitizeForStorage(entryValue);
		}
		return next;
	}
	return value;
}

function readTapeEntriesFromPath(filepath: string): TapeEntry[] {
	if (!fs.existsSync(filepath)) {
		return [];
	}

	const lines = fs.readFileSync(filepath, "utf-8").split(/\r?\n/);
	const entries: TapeEntry[] = [];

	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as unknown;
			if (!isRecord(parsed)) continue;
			const id = parsed.id;
			const kind = parsed.kind;
			const timestamp = parsed.timestamp;
			const payload = parsed.payload;
			const meta = parsed.meta;
			if (typeof id !== "number") continue;
			if (
				kind !== "message" &&
				kind !== "tool_call" &&
				kind !== "tool_result" &&
				kind !== "anchor" &&
				kind !== "event"
			) {
				continue;
			}
			if (typeof timestamp !== "string" || !isRecord(payload)) continue;

			const nextEntry: TapeEntry = {
				id,
				kind,
				timestamp,
				payload,
			};
			if (isRecord(meta)) {
				const nextMeta: TapeMeta = {};
				for (const [key, metaValue] of Object.entries(meta)) {
					if (
						typeof metaValue === "string" ||
						typeof metaValue === "number" ||
						typeof metaValue === "boolean" ||
						metaValue === null
					) {
						nextMeta[key] = metaValue;
					}
				}
				nextEntry.meta = nextMeta;
			}
			entries.push(nextEntry);
		} catch {
			// Ignore malformed lines from partial/manual edits.
		}
	}

	return entries.sort((left, right) => left.id - right.id);
}

function readTapeEntries(ctx: ExtensionContext): TapeEntry[] {
	return readTapeEntriesFromPath(getTapePath(ctx));
}

function appendTapeEntry(
	ctx: ExtensionContext,
	kind: TapeEntryKind,
	payload: Record<string, unknown>,
	meta?: TapeMeta,
): TapeEntry {
	ensureDirs();
	const filepath = getTapePath(ctx);
	const entries = readTapeEntriesFromPath(filepath);
	const nextEntry: TapeEntry = {
		id: entries.length > 0 ? entries[entries.length - 1].id + 1 : 1,
		kind,
		timestamp: new Date().toISOString(),
		payload: sanitizeForStorage(payload) as Record<string, unknown>,
		meta,
	};
	fs.appendFileSync(filepath, `${JSON.stringify(nextEntry)}\n`, "utf-8");
	return nextEntry;
}

function archiveTape(ctx: ExtensionContext): string | undefined {
	const tapePath = getTapePath(ctx);
	if (!fs.existsSync(tapePath)) {
		return undefined;
	}
	ensureDirs();
	const archiveName = `${getTapeName(ctx)}.${new Date().toISOString().replaceAll(":", "-")}.bak.jsonl`;
	const archivePath = path.join(ARCHIVE_DIR, archiveName);
	fs.copyFileSync(tapePath, archivePath);
	return archivePath;
}

function resetTape(ctx: ExtensionContext): void {
	const tapePath = getTapePath(ctx);
	if (fs.existsSync(tapePath)) {
		fs.unlinkSync(tapePath);
	}
}

function ensureBootstrapAnchor(ctx: ExtensionContext, extraState?: Record<string, unknown>): void {
	const entries = readTapeEntries(ctx);
	const hasAnchor = entries.some((entry) => entry.kind === "anchor");
	if (hasAnchor) {
		return;
	}
	appendTapeEntry(
		ctx,
		"anchor",
		{
			name: "session/start",
			state: {
				owner: "human",
				workspace: normalizePath(ctx.cwd),
				sessionId: ctx.sessionManager.getSessionId(),
				...extraState,
			},
		},
		{
			sessionId: ctx.sessionManager.getSessionId(),
		},
	);
}

function truncatePlainText(text: string): TruncatedText {
	const truncation = truncateHead(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!truncation.truncated) {
		return { text, truncated: false };
	}

	const omittedLines = truncation.totalLines - truncation.outputLines;
	const omittedBytes = truncation.totalBytes - truncation.outputBytes;
	return {
		text:
			truncation.content +
			`\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines` +
			` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}), omitted ${omittedLines} lines` +
			` (${formatSize(omittedBytes)})]`,
		truncated: true,
	};
}

function contentToText(content: string | Array<{ type: string } | ImageContent>): string {
	if (typeof content === "string") {
		return redactDataUrls(content);
	}

	const parts: string[] = [];
	for (const part of content) {
		if (part.type === "text" && "text" in part && typeof part.text === "string") {
			parts.push(part.text);
			continue;
		}
		if (
			part.type === "image" &&
			"source" in part &&
			isRecord(part.source) &&
			typeof part.source.mediaType === "string"
		) {
			parts.push(`[image:${part.source.mediaType}]`);
			continue;
		}
		parts.push(`[${part.type}]`);
	}
	return redactDataUrls(parts.join("\n"));
}

function assistantText(content: Array<{ type: string }>): string {
	const parts: string[] = [];
	for (const part of content) {
		if (part.type === "text" && "text" in part && typeof part.text === "string") {
			parts.push(part.text);
			continue;
		}
		if (part.type === "thinking" && "thinking" in part && typeof part.thinking === "string") {
			parts.push(`[thinking] ${part.thinking}`);
			continue;
		}
		if (part.type === "toolCall" && "name" in part && typeof part.name === "string") {
			parts.push(`[tool_call:${part.name}]`);
		}
	}
	return redactDataUrls(parts.join("\n"));
}

function summarize(text: string, maxLength = 220): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (!compact) {
		return "(empty)";
	}
	if (compact.length <= maxLength) {
		return compact;
	}
	return `${compact.slice(0, maxLength - 3)}...`;
}

function tokenize(value: string): string[] {
	return value.toLowerCase().match(WORD_PATTERN) ?? [];
}

function bigrams(value: string): Set<string> {
	const normalized = value.trim().toLowerCase();
	if (normalized.length < 2) {
		return new Set(normalized ? [normalized] : []);
	}
	const result = new Set<string>();
	for (let index = 0; index < normalized.length - 1; index++) {
		result.add(normalized.slice(index, index + 2));
	}
	return result;
}

function diceSimilarity(left: string, right: string): number {
	if (left === right) {
		return 1;
	}
	const leftBigrams = bigrams(left);
	const rightBigrams = bigrams(right);
	if (leftBigrams.size === 0 || rightBigrams.size === 0) {
		return 0;
	}
	let intersection = 0;
	for (const item of leftBigrams) {
		if (rightBigrams.has(item)) {
			intersection++;
		}
	}
	return (2 * intersection) / (leftBigrams.size + rightBigrams.size);
}

function bestFuzzyScore(normalizedQuery: string, haystack: string): number {
	if (normalizedQuery.length < MIN_FUZZY_QUERY_LENGTH) {
		return 0;
	}

	const queryTokens = tokenize(normalizedQuery);
	if (queryTokens.length === 0) {
		return 0;
	}

	const sourceTokens = tokenize(haystack);
	if (sourceTokens.length === 0) {
		return 0;
	}

	const candidates: string[] = [];
	for (const token of sourceTokens) {
		candidates.push(token);
		if (candidates.length >= MAX_FUZZY_CANDIDATES) {
			break;
		}
	}

	const windowSize = queryTokens.length;
	if (windowSize > 1) {
		for (let index = 0; index <= sourceTokens.length - windowSize; index++) {
			candidates.push(sourceTokens.slice(index, index + windowSize).join(" "));
			if (candidates.length >= MAX_FUZZY_CANDIDATES) {
				break;
			}
		}
	}

	const queryPhrase = queryTokens.join(" ");
	let best = 0;
	for (const candidate of candidates) {
		best = Math.max(best, diceSimilarity(queryPhrase, candidate));
		if (best >= MIN_FUZZY_SCORE) {
			return best;
		}
	}
	return best;
}

function entryHaystack(entry: TapeEntry): string {
	return `${JSON.stringify(entry.payload)} ${JSON.stringify(entry.meta ?? {})}`.toLowerCase();
}

function searchTape(entries: TapeEntry[], query: string, limit: number): SearchHit[] {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) {
		return [];
	}

	const queryTokens = tokenize(normalizedQuery);
	const seen = new Set<string>();
	const results: SearchHit[] = [];

	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		const haystack = entryHaystack(entry);
		if (seen.has(haystack)) {
			continue;
		}
		seen.add(haystack);

		let score = 0;
		if (haystack.includes(normalizedQuery)) {
			score += 100;
		}
		for (const token of queryTokens) {
			if (haystack.includes(token)) {
				score += 10;
			}
		}

		const fuzzyScore = bestFuzzyScore(normalizedQuery, haystack);
		if (fuzzyScore >= MIN_FUZZY_SCORE) {
			score += Math.round(fuzzyScore * 25);
		}

		if (score > 0) {
			results.push({ entry, score });
		}
	}

	results.sort((left, right) => right.score - left.score || right.entry.id - left.entry.id);
	return results.slice(0, Math.min(limit, MAX_SEARCH_RESULTS));
}

function getLastAnchorIndex(entries: TapeEntry[]): number {
	for (let index = entries.length - 1; index >= 0; index--) {
		if (entries[index].kind === "anchor") {
			return index;
		}
	}
	return -1;
}

function getTapeInfo(entries: TapeEntry[], tapeName: string): TapeInfo {
	const anchorIndex = getLastAnchorIndex(entries);
	const anchors = entries.filter((entry) => entry.kind === "anchor");
	let lastTokenUsage: number | undefined;

	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.kind !== "event") continue;
		if (entry.payload.name !== "run") continue;
		const data = entry.payload.data;
		if (!isRecord(data)) continue;
		const usage = data.usage;
		if (!isRecord(usage)) continue;
		const totalTokens = usage.totalTokens;
		if (typeof totalTokens === "number") {
			lastTokenUsage = totalTokens;
			break;
		}
	}

	return {
		name: tapeName,
		entries: entries.length,
		anchors: anchors.length,
		lastAnchor:
			anchors.length > 0 && typeof anchors[anchors.length - 1].payload.name === "string"
				? (anchors[anchors.length - 1].payload.name as string)
				: undefined,
		entriesSinceLastAnchor: anchorIndex >= 0 ? entries.length - anchorIndex - 1 : entries.length,
		lastTokenUsage,
	};
}

function entryLabel(entry: TapeEntry): string {
	switch (entry.kind) {
		case "message":
			return typeof entry.payload.role === "string" ? entry.payload.role : "message";
		case "tool_call":
			return "tool_call";
		case "tool_result":
			return typeof entry.payload.toolName === "string" ? `tool:${entry.payload.toolName}` : "tool_result";
		case "anchor":
			return typeof entry.payload.name === "string" ? `anchor:${entry.payload.name}` : "anchor";
		case "event":
			return typeof entry.payload.name === "string" ? `event:${entry.payload.name}` : "event";
	}
}

function entryPreview(entry: TapeEntry): string {
	switch (entry.kind) {
		case "message":
			return summarize(typeof entry.payload.text === "string" ? entry.payload.text : JSON.stringify(entry.payload));
		case "tool_call": {
			const calls = Array.isArray(entry.payload.calls) ? entry.payload.calls : [];
			const names = calls
				.map((call) => (isRecord(call) && typeof call.name === "string" ? call.name : "unknown"))
				.join(", ");
			return summarize(names || JSON.stringify(entry.payload));
		}
		case "tool_result":
			return summarize(typeof entry.payload.text === "string" ? entry.payload.text : JSON.stringify(entry.payload));
		case "anchor": {
			const state = entry.payload.state;
			if (isRecord(state) && typeof state.summary === "string" && state.summary.trim()) {
				return summarize(state.summary);
			}
			return summarize(JSON.stringify(entry.payload));
		}
		case "event":
			return summarize(JSON.stringify(entry.payload));
	}
}

function formatEntryLine(entry: TapeEntry): string {
	return `#${entry.id} ${entry.timestamp} ${entryLabel(entry)} ${entryPreview(entry)}`;
}

function formatEntryDetails(entry: TapeEntry): string {
	const parts = [`#${entry.id} ${entry.kind} ${entry.timestamp}`, JSON.stringify(entry.payload, null, 2)];
	if (entry.meta && Object.keys(entry.meta).length > 0) {
		parts.push(JSON.stringify(entry.meta, null, 2));
	}
	return parts.join("\n");
}

function buildPromptContext(entries: TapeEntry[]): string {
	const anchorIndex = getLastAnchorIndex(entries);
	const anchor = anchorIndex >= 0 ? entries[anchorIndex] : undefined;
	const recentEntries = entries
		.slice(anchorIndex >= 0 ? anchorIndex + 1 : 0)
		.filter((entry) => entry.kind !== "event")
		.slice(-AUTO_CONTEXT_ENTRY_LIMIT);

	const sections: string[] = [
		"## Bub Memomry",
		`Persistent tape memory is stored in ${TAPES_DIR}.`,
		"Use bub_memomry_search before answering questions about prior work, prior decisions, tool activity, anchors, or earlier sessions.",
		"Use bub_memomry_handoff after major milestones to create a named checkpoint with a concise summary.",
	];

	if (anchor && typeof anchor.payload.name === "string") {
		let anchorText = `Latest anchor: ${anchor.payload.name}`;
		const state = anchor.payload.state;
		if (isRecord(state) && typeof state.summary === "string" && state.summary.trim()) {
			anchorText += `\nSummary: ${summarize(state.summary, 400)}`;
		}
		sections.push("", anchorText);
	}

	if (recentEntries.length > 0) {
		sections.push("", "Recent tape entries:");
		for (const entry of recentEntries) {
			sections.push(`- ${formatEntryLine(entry)}`);
		}
	}

	let text = sections.join("\n");
	if (text.length <= MAX_AUTO_INJECT_CHARS) {
		return text;
	}

	while (text.length > MAX_AUTO_INJECT_CHARS && recentEntries.length > 1) {
		recentEntries.shift();
		const trimmedSections = sections.slice(0, sections.indexOf("Recent tape entries:") + 1);
		for (const entry of recentEntries) {
			trimmedSections.push(`- ${formatEntryLine(entry)}`);
		}
		text = trimmedSections.join("\n");
	}

	return text.slice(0, MAX_AUTO_INJECT_CHARS);
}

function refreshStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) {
		return;
	}
	const info = getTapeInfo(readTapeEntries(ctx), getTapeName(ctx));
	const parts = [`${info.entries} entries`, `${info.anchors} anchors`];
	if (info.lastAnchor) {
		parts.push(info.lastAnchor);
	}
	ctx.ui.setStatus(EXTENSION_NAME, parts.join(" | "));
}

function isUserMessage(message: unknown): message is UserMessage {
	return isRecord(message) && message.role === "user" && "content" in message;
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
	return isRecord(message) && message.role === "assistant" && Array.isArray(message.content);
}

function isToolResultMessage(message: unknown): message is ToolResultMessage {
	return isRecord(message) && message.role === "toolResult" && Array.isArray(message.content);
}

function recordMessageEnd(message: unknown, ctx: ExtensionContext): void {
	if (isUserMessage(message)) {
		appendTapeEntry(
			ctx,
			"message",
			{
				role: "user",
				text: contentToText(message.content),
				content: message.content,
			},
			{
				sessionId: ctx.sessionManager.getSessionId(),
			},
		);
		return;
	}

	if (isAssistantMessage(message)) {
		appendTapeEntry(
			ctx,
			"message",
			{
				role: "assistant",
				text: assistantText(message.content),
				content: message.content,
				stopReason: message.stopReason,
				usage: message.usage,
			},
			{
				sessionId: ctx.sessionManager.getSessionId(),
				model: message.model,
				provider: message.provider,
			},
		);

		const toolCalls = message.content.filter((part): part is ToolCall => part.type === "toolCall");
		if (toolCalls.length > 0) {
			appendTapeEntry(
				ctx,
				"tool_call",
				{
					calls: toolCalls.map((call) => ({
						id: call.id,
						name: call.name,
						arguments: call.arguments,
					})),
				},
				{
					sessionId: ctx.sessionManager.getSessionId(),
				},
			);
		}
		return;
	}

	if (isToolResultMessage(message)) {
		appendTapeEntry(
			ctx,
			"tool_result",
			{
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				text: contentToText(message.content),
				content: message.content,
				details: message.details,
				isError: message.isError,
			},
			{
				sessionId: ctx.sessionManager.getSessionId(),
				isError: message.isError,
			},
		);
		return;
	}
}

function overviewLines(ctx: ExtensionContext): string[] {
	const entries = readTapeEntries(ctx);
	const info = getTapeInfo(entries, getTapeName(ctx));
	const anchors = entries
		.filter((entry) => entry.kind === "anchor")
		.slice(-5)
		.reverse();

	const lines = [
		`Tape: ${info.name}`,
		`File: ${getTapePath(ctx)}`,
		`Entries: ${info.entries}`,
		`Anchors: ${info.anchors}`,
		`Last anchor: ${info.lastAnchor ?? "-"}`,
		`Entries since last anchor: ${info.entriesSinceLastAnchor}`,
		`Last token usage: ${info.lastTokenUsage ?? "-"}`,
		"",
		"Recent anchors:",
	];

	if (anchors.length === 0) {
		lines.push("- (none)");
	} else {
		for (const anchor of anchors) {
			lines.push(`- ${formatEntryLine(anchor)}`);
		}
	}

	return lines;
}

export default function bubMemomryExtension(pi: ExtensionAPI) {
	ensureDirs();

	pi.on("session_start", async (_event, ctx) => {
		ensureBootstrapAnchor(ctx);
		refreshStatus(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		ensureBootstrapAnchor(ctx);
		refreshStatus(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		ensureBootstrapAnchor(ctx);
		refreshStatus(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		recordMessageEnd(event.message, ctx);
	});

	pi.on("agent_end", async (event, ctx) => {
		const assistantMessages = event.messages.filter(
			(message): message is Extract<(typeof event.messages)[number], { role: "assistant" }> =>
				message.role === "assistant",
		);
		const lastAssistant = assistantMessages[assistantMessages.length - 1];
		appendTapeEntry(
			ctx,
			"event",
			{
				name: "run",
				data: {
					messageCount: event.messages.length,
					usage: lastAssistant?.usage ? { totalTokens: lastAssistant.usage.totalTokens } : undefined,
				},
			},
			{
				sessionId: ctx.sessionManager.getSessionId(),
			},
		);
		refreshStatus(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		ensureBootstrapAnchor(ctx);
		const entries = readTapeEntries(ctx);
		const memoryBlock = buildPromptContext(entries);
		return {
			systemPrompt: `${event.systemPrompt}\n\n${memoryBlock}`,
		};
	});

	pi.registerTool({
		name: "bub_memomry_info",
		label: "Bub Memomry Info",
		description: "Show information about the current Bub-style tape memory for this workspace and session.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			ensureBootstrapAnchor(ctx);
			const info = getTapeInfo(readTapeEntries(ctx), getTapeName(ctx));
			const text = [
				`name: ${info.name}`,
				`file: ${getTapePath(ctx)}`,
				`entries: ${info.entries}`,
				`anchors: ${info.anchors}`,
				`last_anchor: ${info.lastAnchor ?? "-"}`,
				`entries_since_last_anchor: ${info.entriesSinceLastAnchor}`,
				`last_token_usage: ${info.lastTokenUsage ?? "-"}`,
			].join("\n");
			return {
				content: [{ type: "text", text }],
				details: info,
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("bub_memomry_info")), 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = result.content[0];
			return new Text(theme.fg("muted", text?.type === "text" ? text.text.replace(/\n/g, " | ") : ""), 0, 0);
		},
	});

	pi.registerTool({
		name: "bub_memomry_search",
		label: "Bub Memomry Search",
		description:
			"Search the structured tape memory for prior decisions, notes, tool activity, and anchors across this workspace/session.",
		promptSnippet: "bub_memomry_search - Search Bub-style structured tape memory",
		promptGuidelines: [
			"Before answering questions about prior work, prior decisions, anchors, or tool activity, search tape memory first.",
			"If the search returns nothing relevant, say so explicitly instead of fabricating recall.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			limit: Type.Optional(Type.Number({ description: "Maximum results to return (default 10)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ensureBootstrapAnchor(ctx);
			const hits = searchTape(readTapeEntries(ctx), params.query, params.limit ?? 10);
			if (hits.length === 0) {
				return {
					content: [{ type: "text", text: `(no matches for "${params.query}")` }],
					details: { query: params.query, count: 0 },
				};
			}
			const body = hits.map((hit) => formatEntryLine(hit.entry)).join("\n");
			return {
				content: [{ type: "text", text: body }],
				details: { query: params.query, count: hits.length },
			};
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("bub_memomry_search"))} ${theme.fg("dim", `"${args.query}"`)}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const details = isRecord(result.details) ? result.details : undefined;
			const count = typeof details?.count === "number" ? details.count : 0;
			return new Text(theme.fg("muted", count > 0 ? `${count} hit(s)` : "No matches"), 0, 0);
		},
	});

	pi.registerTool({
		name: "bub_memomry_read",
		label: "Bub Memomry Read",
		description:
			"Read raw tape entries from the current Bub-style memory. Use this after search to inspect stored payloads in detail.",
		parameters: Type.Object({
			kind: Type.Optional(
				StringEnum(["message", "tool_call", "tool_result", "anchor", "event"] as const, {
					description: "Optional kind filter",
				}),
			),
			from_id: Type.Optional(Type.Number({ description: "Start from this tape entry id" })),
			limit: Type.Optional(Type.Number({ description: "Number of entries to return (default 20)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ensureBootstrapAnchor(ctx);
			let entries = readTapeEntries(ctx);
			if (params.kind) {
				entries = entries.filter((entry) => entry.kind === params.kind);
			}
			if (params.from_id !== undefined) {
				const fromId = params.from_id;
				entries = entries.filter((entry) => entry.id >= fromId);
			}
			entries = entries.slice(0, Math.max(1, params.limit ?? DEFAULT_READ_LIMIT));

			if (entries.length === 0) {
				return {
					content: [{ type: "text", text: "(no entries)" }],
					details: { count: 0 },
				};
			}

			const rawText = entries.map((entry) => formatEntryDetails(entry)).join("\n\n");
			const truncated = truncatePlainText(rawText);
			return {
				content: [{ type: "text", text: truncated.text }],
				details: { count: entries.length, truncated: truncated.truncated },
			};
		},
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("bub_memomry_read"));
			if (args.kind) {
				text += ` ${theme.fg("accent", args.kind)}`;
			}
			if (args.from_id !== undefined) {
				text += ` ${theme.fg("dim", `from #${args.from_id}`)}`;
			}
			if (args.limit !== undefined) {
				text += ` ${theme.fg("dim", `limit ${args.limit}`)}`;
			}
			return new Text(text, 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = isRecord(result.details) ? result.details : undefined;
			const count = typeof details?.count === "number" ? details.count : 0;
			const truncated = details?.truncated === true;
			return new Text(
				theme.fg("muted", `${count} entr${count === 1 ? "y" : "ies"}${truncated ? " (truncated)" : ""}`),
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "bub_memomry_handoff",
		label: "Bub Memomry Handoff",
		description: "Create a named anchor/checkpoint in tape memory with an optional summary for later recall.",
		promptSnippet: "bub_memomry_handoff - Save a named anchor/checkpoint in tape memory",
		promptGuidelines: [
			"After major milestones, create a handoff anchor with a short summary so future sessions can resume cleanly.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Anchor name, e.g. refactor-done or session/handoff" }),
			summary: Type.Optional(Type.String({ description: "Optional concise summary of the checkpoint" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ensureBootstrapAnchor(ctx);
			appendTapeEntry(
				ctx,
				"anchor",
				{
					name: params.name,
					state: {
						summary: params.summary ?? "",
						owner: "human",
						workspace: normalizePath(ctx.cwd),
						sessionId: ctx.sessionManager.getSessionId(),
					},
				},
				{
					sessionId: ctx.sessionManager.getSessionId(),
				},
			);

			const leafId = ctx.sessionManager.getLeafId();
			if (leafId) {
				pi.setLabel(leafId, params.name);
			}
			refreshStatus(ctx);

			return {
				content: [{ type: "text", text: `Anchor saved: ${params.name}` }],
				details: { name: params.name },
			};
		},
		renderCall(args, theme) {
			let text = `${theme.fg("toolTitle", theme.bold("bub_memomry_handoff"))} ${theme.fg("accent", args.name)}`;
			if (args.summary) {
				text += ` ${theme.fg("dim", summarize(args.summary, 80))}`;
			}
			return new Text(text, 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = result.content[0];
			return new Text(theme.fg("muted", text?.type === "text" ? text.text : "Anchor saved"), 0, 0);
		},
	});

	pi.registerTool({
		name: "bub_memomry_anchors",
		label: "Bub Memomry Anchors",
		description: "List recent anchors/checkpoints stored in the current tape memory.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			ensureBootstrapAnchor(ctx);
			const anchors = readTapeEntries(ctx).filter((entry) => entry.kind === "anchor");
			if (anchors.length === 0) {
				return {
					content: [{ type: "text", text: "(no anchors)" }],
					details: { count: 0 },
				};
			}
			const lines = anchors
				.slice(-20)
				.map((entry) => formatEntryLine(entry))
				.join("\n");
			return {
				content: [{ type: "text", text: lines }],
				details: { count: anchors.length },
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("bub_memomry_anchors")), 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = isRecord(result.details) ? result.details : undefined;
			const count = typeof details?.count === "number" ? details.count : 0;
			return new Text(theme.fg("muted", `${count} anchor(s)`), 0, 0);
		},
	});

	pi.registerTool({
		name: "bub_memomry_reset",
		label: "Bub Memomry Reset",
		description: "Reset the current tape memory, optionally archiving the old JSONL file first.",
		parameters: Type.Object({
			archive: Type.Optional(Type.Boolean({ description: "Archive the tape before resetting it" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const archivedPath = params.archive ? archiveTape(ctx) : undefined;
			resetTape(ctx);
			ensureBootstrapAnchor(
				ctx,
				archivedPath
					? {
							archived: archivedPath,
						}
					: undefined,
			);
			refreshStatus(ctx);
			return {
				content: [
					{
						type: "text",
						text: archivedPath ? `Tape reset. Archived to ${archivedPath}` : "Tape reset.",
					},
				],
				details: { archivedPath },
			};
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("bub_memomry_reset"))}${args.archive ? theme.fg("dim", " archive") : ""}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const text = result.content[0];
			return new Text(theme.fg("muted", text?.type === "text" ? text.text : "Tape reset"), 0, 0);
		},
	});

	pi.registerCommand("bub-memomry", {
		description: "Show an overview of the current Bub-style tape memory",
		handler: async (_args, ctx) => {
			ensureBootstrapAnchor(ctx);
			const lines = overviewLines(ctx);
			if (!ctx.hasUI) {
				ctx.ui.notify(lines.join(" | "), "info");
				return;
			}
			await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
				return new TapeOverviewComponent(lines, theme, () => done());
			});
		},
	});

	pi.registerTool({
		name: "bub_memomry_overview",
		label: "Bub Memomry Overview",
		description: "Show the same overview as /bub-memomry for the current tape memory.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			ensureBootstrapAnchor(ctx);
			return {
				content: [{ type: "text", text: overviewLines(ctx).join("\n") }],
				details: { lines: overviewLines(ctx).length },
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("bub_memomry_overview")), 0, 0);
		},
		renderResult(_result, _options, theme) {
			return new Text(theme.fg("muted", "Overview ready"), 0, 0);
		},
	});
}
