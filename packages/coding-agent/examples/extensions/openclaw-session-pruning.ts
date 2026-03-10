/**
 * OpenClaw Session Pruning Extension
 *
 * Transiently trims old tool results from the in-memory context before eligible
 * LLM calls. Inspired by OpenClaw's session-pruning mechanism:
 * - only toolResult messages are pruned
 * - the last few assistant messages are protected
 * - pruning is TTL-aware so it mainly runs after prompt-cache expiry
 * - the on-disk session transcript is left untouched
 *
 * Usage:
 *   pi --extension examples/extensions/openclaw-session-pruning.ts
 *
 * Optional command:
 *   /openclaw-session-pruning
 *   /openclaw-session-pruning reset
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent, ToolResultMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";

const EXTENSION_NAME = "openclaw-session-pruning";
const STATE_ENTRY_TYPE = `${EXTENSION_NAME}-state`;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
const CHARS_PER_TOKEN_ESTIMATE = 4;
const IMAGE_CHAR_ESTIMATE = 8_000;

interface ToolMatch {
	allow: string[];
	deny: string[];
}

interface SoftTrimSettings {
	maxChars: number;
	headChars: number;
	tailChars: number;
}

interface HardClearSettings {
	enabled: boolean;
	placeholder: string;
}

interface PruningSettings {
	ttlMs: number;
	keepLastAssistants: number;
	softTrimRatio: number;
	hardClearRatio: number;
	minPrunableToolChars: number;
	tools: ToolMatch;
	softTrim: SoftTrimSettings;
	hardClear: HardClearSettings;
}

interface RuntimeState {
	lastTouchAt: number | null;
	lastPrunedAt: number | null;
	lastPrunedToolResults: number;
	totalPrunes: number;
	lastModel: string | null;
}

interface PersistedState extends Partial<RuntimeState> {}

interface PruneResult {
	messages: AgentMessage[];
	affectedCount: number;
	softTrimmedCount: number;
	hardClearedCount: number;
}

const SETTINGS: PruningSettings = {
	ttlMs: parseDurationMs("5m"),
	keepLastAssistants: 3,
	softTrimRatio: 0.3,
	hardClearRatio: 0.5,
	minPrunableToolChars: 50_000,
	tools: {
		allow: [],
		deny: [],
	},
	softTrim: {
		maxChars: 4_000,
		headChars: 1_500,
		tailChars: 1_500,
	},
	hardClear: {
		enabled: true,
		placeholder: "[Old tool result content cleared]",
	},
};

const ALLOW_PATTERNS = compilePatterns(SETTINGS.tools.allow);
const DENY_PATTERNS = compilePatterns(SETTINGS.tools.deny);

function parseDurationMs(raw: string): number {
	const input = raw.trim().toLowerCase();
	if (!input) {
		throw new Error("Duration must not be empty");
	}

	if (/^\d+(?:\.\d+)?$/.test(input)) {
		return Math.floor(Number(input) * 60_000);
	}

	const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;
	let total = 0;
	let matched = 0;

	for (const match of input.matchAll(pattern)) {
		const value = Number(match[1]);
		const unit = match[2];
		matched += match[0].length;
		if (unit === "ms") total += value;
		if (unit === "s") total += value * 1_000;
		if (unit === "m") total += value * 60_000;
		if (unit === "h") total += value * 60 * 60_000;
		if (unit === "d") total += value * 24 * 60 * 60_000;
	}

	if (matched !== input.length || total <= 0) {
		throw new Error(`Invalid duration: ${raw}`);
	}

	return Math.floor(total);
}

function asText(text: string): TextContent {
	return { type: "text", text };
}

function compilePatterns(patterns: string[]): RegExp[] {
	return patterns
		.map((pattern) => pattern.trim().toLowerCase())
		.filter(Boolean)
		.map((pattern) => {
			const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
			return new RegExp(`^${escaped}$`, "i");
		});
}

function isToolPrunable(toolName: string): boolean {
	const normalized = toolName.trim().toLowerCase();
	if (!normalized) {
		return false;
	}
	if (DENY_PATTERNS.some((pattern) => pattern.test(normalized))) {
		return false;
	}
	if (ALLOW_PATTERNS.length === 0) {
		return true;
	}
	return ALLOW_PATTERNS.some((pattern) => pattern.test(normalized));
}

function collectTextSegments(content: ReadonlyArray<TextContent | ImageContent>): string[] {
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") {
			parts.push(block.text);
		}
	}
	return parts;
}

function estimateJoinedTextLength(parts: string[]): number {
	if (parts.length === 0) {
		return 0;
	}
	return parts.reduce((sum, part) => sum + part.length, 0) + Math.max(0, parts.length - 1);
}

function takeHead(parts: string[], maxChars: number): string {
	if (maxChars <= 0 || parts.length === 0) {
		return "";
	}
	let remaining = maxChars;
	let output = "";
	for (let index = 0; index < parts.length && remaining > 0; index++) {
		if (index > 0) {
			output += "\n";
			remaining -= 1;
			if (remaining <= 0) {
				break;
			}
		}
		const part = parts[index];
		if (part.length <= remaining) {
			output += part;
			remaining -= part.length;
			continue;
		}
		output += part.slice(0, remaining);
		remaining = 0;
	}
	return output;
}

function takeTail(parts: string[], maxChars: number): string {
	if (maxChars <= 0 || parts.length === 0) {
		return "";
	}
	let remaining = maxChars;
	const chunks: string[] = [];
	for (let index = parts.length - 1; index >= 0 && remaining > 0; index--) {
		const part = parts[index];
		if (part.length <= remaining) {
			chunks.push(part);
			remaining -= part.length;
		} else {
			chunks.push(part.slice(part.length - remaining));
			remaining = 0;
		}
		if (remaining > 0 && index > 0) {
			chunks.push("\n");
			remaining -= 1;
		}
	}
	chunks.reverse();
	return chunks.join("");
}

function hasImageBlocks(content: ReadonlyArray<TextContent | ImageContent>): boolean {
	return content.some((block) => block.type === "image");
}

function estimateContentChars(content: string | ReadonlyArray<TextContent | ImageContent>): number {
	if (typeof content === "string") {
		return content.length;
	}
	let chars = 0;
	for (const block of content) {
		if (block.type === "text") {
			chars += block.text.length;
			continue;
		}
		chars += IMAGE_CHAR_ESTIMATE;
	}
	return chars;
}

function estimateMessageChars(message: AgentMessage): number {
	if (message.role === "user") {
		return estimateContentChars(message.content);
	}

	if (message.role === "assistant") {
		let chars = 0;
		for (const block of message.content) {
			if (block.type === "text") {
				chars += block.text.length;
				continue;
			}
			if (block.type === "thinking") {
				chars += block.thinking.length;
				continue;
			}
			if (block.type === "toolCall") {
				try {
					chars += JSON.stringify(block.arguments ?? {}).length;
				} catch {
					chars += 128;
				}
			}
		}
		return chars;
	}

	if (message.role === "toolResult") {
		return estimateContentChars(message.content);
	}

	return 256;
}

function estimateContextChars(messages: AgentMessage[]): number {
	return messages.reduce((sum, message) => sum + estimateMessageChars(message), 0);
}

function findAssistantCutoffIndex(messages: AgentMessage[], keepLastAssistants: number): number | null {
	if (keepLastAssistants <= 0) {
		return messages.length;
	}

	let remaining = keepLastAssistants;
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role !== "assistant") {
			continue;
		}
		remaining -= 1;
		if (remaining === 0) {
			return index;
		}
	}

	return null;
}

function findFirstUserIndex(messages: AgentMessage[]): number | null {
	for (let index = 0; index < messages.length; index++) {
		if (messages[index]?.role === "user") {
			return index;
		}
	}
	return null;
}

function softTrimToolResultMessage(message: ToolResultMessage, settings: PruningSettings): ToolResultMessage | null {
	if (hasImageBlocks(message.content)) {
		return null;
	}

	const parts = collectTextSegments(message.content);
	const rawLength = estimateJoinedTextLength(parts);
	if (rawLength <= settings.softTrim.maxChars) {
		return null;
	}

	const headChars = Math.max(0, settings.softTrim.headChars);
	const tailChars = Math.max(0, settings.softTrim.tailChars);
	if (headChars + tailChars >= rawLength) {
		return null;
	}

	const head = takeHead(parts, headChars);
	const tail = takeTail(parts, tailChars);
	const note = `\n\n[Tool result trimmed: kept first ${headChars} chars and last ${tailChars} chars of ${rawLength} chars.]`;
	return {
		...message,
		content: [asText(`${head}\n...\n${tail}${note}`)],
	};
}

function pruneContextMessages(messages: AgentMessage[], ctx: ExtensionContext): PruneResult {
	const contextWindowTokens = ctx.model?.contextWindow ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
	const charWindow = contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE;
	if (charWindow <= 0) {
		return { messages, affectedCount: 0, softTrimmedCount: 0, hardClearedCount: 0 };
	}

	const cutoffIndex = findAssistantCutoffIndex(messages, SETTINGS.keepLastAssistants);
	if (cutoffIndex === null) {
		return { messages, affectedCount: 0, softTrimmedCount: 0, hardClearedCount: 0 };
	}

	const firstUserIndex = findFirstUserIndex(messages);
	const pruneStartIndex = firstUserIndex === null ? messages.length : firstUserIndex;

	const prunableToolIndexes: number[] = [];
	let next: AgentMessage[] | null = null;
	let softTrimmedCount = 0;
	let hardClearedCount = 0;
	const affectedIndexes = new Set<number>();
	let totalChars = estimateContextChars(messages);

	if (totalChars / charWindow < SETTINGS.softTrimRatio) {
		return { messages, affectedCount: 0, softTrimmedCount, hardClearedCount };
	}

	for (let index = pruneStartIndex; index < cutoffIndex; index++) {
		const message = messages[index];
		if (!message || message.role !== "toolResult") {
			continue;
		}
		if (!isToolPrunable(message.toolName) || hasImageBlocks(message.content)) {
			continue;
		}

		prunableToolIndexes.push(index);
		const updated = softTrimToolResultMessage(message as ToolResultMessage, SETTINGS);
		if (!updated) {
			continue;
		}

		const beforeChars = estimateMessageChars(message);
		const afterChars = estimateMessageChars(updated as AgentMessage);
		totalChars += afterChars - beforeChars;
		if (!next) {
			next = messages.slice();
		}
		next[index] = updated as AgentMessage;
		softTrimmedCount += 1;
		affectedIndexes.add(index);
	}

	const outputAfterSoftTrim = next ?? messages;
	let ratio = totalChars / charWindow;
	if (ratio < SETTINGS.hardClearRatio || !SETTINGS.hardClear.enabled) {
		return {
			messages: outputAfterSoftTrim,
			affectedCount: affectedIndexes.size,
			softTrimmedCount,
			hardClearedCount,
		};
	}

	let prunableToolChars = 0;
	for (const index of prunableToolIndexes) {
		const message = outputAfterSoftTrim[index];
		if (!message || message.role !== "toolResult") {
			continue;
		}
		prunableToolChars += estimateMessageChars(message);
	}
	if (prunableToolChars < SETTINGS.minPrunableToolChars) {
		return {
			messages: outputAfterSoftTrim,
			affectedCount: affectedIndexes.size,
			softTrimmedCount,
			hardClearedCount,
		};
	}

	for (const index of prunableToolIndexes) {
		if (ratio < SETTINGS.hardClearRatio) {
			break;
		}

		const message = (next ?? messages)[index];
		if (!message || message.role !== "toolResult") {
			continue;
		}

		const beforeChars = estimateMessageChars(message);
		const cleared: ToolResultMessage = {
			...message,
			content: [asText(SETTINGS.hardClear.placeholder)],
		};
		if (!next) {
			next = messages.slice();
		}
		next[index] = cleared as AgentMessage;
		const afterChars = estimateMessageChars(cleared as AgentMessage);
		totalChars += afterChars - beforeChars;
		ratio = totalChars / charWindow;
		hardClearedCount += 1;
		affectedIndexes.add(index);
	}

	return {
		messages: next ?? messages,
		affectedCount: affectedIndexes.size,
		softTrimmedCount,
		hardClearedCount,
	};
}

function createDefaultState(): RuntimeState {
	return {
		lastTouchAt: null,
		lastPrunedAt: null,
		lastPrunedToolResults: 0,
		totalPrunes: 0,
		lastModel: null,
	};
}

function loadState(ctx: ExtensionContext): RuntimeState {
	const entry = ctx.sessionManager
		.getEntries()
		.filter(
			(item: { type: string; customType?: string }) =>
				item.type === "custom" && item.customType === STATE_ENTRY_TYPE,
		)
		.pop() as { data?: PersistedState } | undefined;

	const next = createDefaultState();
	if (typeof entry?.data?.lastTouchAt === "number") {
		next.lastTouchAt = entry.data.lastTouchAt;
	}
	if (typeof entry?.data?.lastPrunedAt === "number") {
		next.lastPrunedAt = entry.data.lastPrunedAt;
	}
	if (typeof entry?.data?.lastPrunedToolResults === "number") {
		next.lastPrunedToolResults = entry.data.lastPrunedToolResults;
	}
	if (typeof entry?.data?.totalPrunes === "number") {
		next.totalPrunes = entry.data.totalPrunes;
	}
	if (typeof entry?.data?.lastModel === "string") {
		next.lastModel = entry.data.lastModel;
	}
	return next;
}

function persistState(pi: ExtensionAPI, state: RuntimeState): void {
	pi.appendEntry<RuntimeState>(STATE_ENTRY_TYPE, state);
}

function formatAge(timestamp: number | null): string {
	if (!timestamp) {
		return "never";
	}
	const elapsedMs = Date.now() - timestamp;
	if (elapsedMs < 60_000) {
		return `${Math.max(1, Math.floor(elapsedMs / 1_000))}s ago`;
	}
	if (elapsedMs < 60 * 60_000) {
		return `${Math.floor(elapsedMs / 60_000)}m ago`;
	}
	if (elapsedMs < 24 * 60 * 60_000) {
		return `${Math.floor(elapsedMs / (60 * 60_000))}h ago`;
	}
	return `${Math.floor(elapsedMs / (24 * 60 * 60_000))}d ago`;
}

function formatStatus(state: RuntimeState): string {
	return `ttl ${Math.floor(SETTINGS.ttlMs / 60_000)}m | touch ${formatAge(state.lastTouchAt)} | prunes ${state.totalPrunes}`;
}

function updateStatus(ctx: ExtensionContext, state: RuntimeState): void {
	if (!ctx.hasUI) {
		return;
	}
	ctx.ui.setStatus(EXTENSION_NAME, formatStatus(state));
}

function isEligibleModel(ctx: ExtensionContext): boolean {
	const provider = ctx.model?.provider?.toLowerCase();
	const modelId = ctx.model?.id?.toLowerCase() ?? "";
	if (!provider) {
		return false;
	}
	if (provider === "anthropic" || provider === "moonshot" || provider === "zai") {
		return true;
	}
	if (provider === "openrouter") {
		return (
			modelId.startsWith("anthropic/") ||
			modelId.startsWith("moonshot/") ||
			modelId.startsWith("moonshotai/") ||
			modelId.startsWith("zai/")
		);
	}
	if (provider === "kilocode") {
		return modelId.startsWith("anthropic/");
	}
	return false;
}

function modelLabel(ctx: ExtensionContext): string {
	if (!ctx.model) {
		return "unknown";
	}
	return `${ctx.model.provider}/${ctx.model.id}`;
}

function showRuntimeSummary(ctx: ExtensionCommandContext, state: RuntimeState): void {
	const summary = [
		`${EXTENSION_NAME}`,
		`model: ${state.lastModel ?? modelLabel(ctx)}`,
		`ttl: ${SETTINGS.ttlMs}ms`,
		`last touch: ${formatAge(state.lastTouchAt)}`,
		`last prune: ${formatAge(state.lastPrunedAt)}`,
		`last pruned results: ${state.lastPrunedToolResults}`,
		`total prunes: ${state.totalPrunes}`,
	].join(" | ");
	ctx.ui.notify(summary, "info");
}

export default function openclawSessionPruningExtension(pi: ExtensionAPI): void {
	let state = createDefaultState();

	const restoreState = (ctx: ExtensionContext) => {
		state = loadState(ctx);
		updateStatus(ctx, state);
	};

	pi.on("session_start", async (_event, ctx) => {
		restoreState(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		restoreState(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		restoreState(ctx);
	});

	pi.on("context", async (event, ctx) => {
		if (!isEligibleModel(ctx)) {
			return;
		}
		if (!state.lastTouchAt) {
			return;
		}
		if (Date.now() - state.lastTouchAt < SETTINGS.ttlMs) {
			return;
		}

		const result = pruneContextMessages(event.messages, ctx);
		if (result.messages === event.messages) {
			return;
		}

		state.lastTouchAt = Date.now();
		state.lastPrunedAt = state.lastTouchAt;
		state.lastPrunedToolResults = result.affectedCount;
		state.totalPrunes += 1;
		state.lastModel = modelLabel(ctx);
		updateStatus(ctx, state);

		if (ctx.hasUI) {
			ctx.ui.notify(
				`Pruned ${state.lastPrunedToolResults} tool result(s) for ${state.lastModel} ` +
					`(soft ${result.softTrimmedCount}, hard ${result.hardClearedCount})`,
				"info",
			);
		}

		return { messages: result.messages };
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!isEligibleModel(ctx)) {
			return;
		}
		state.lastTouchAt = Date.now();
		state.lastModel = modelLabel(ctx);
		persistState(pi, state);
		updateStatus(ctx, state);
	});

	pi.registerCommand("openclaw-session-pruning", {
		description: "Show or reset the OpenClaw-style session pruning runtime state",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			if (command === "reset") {
				state.lastTouchAt = Date.now() - SETTINGS.ttlMs - 1;
				state.lastPrunedAt = null;
				state.lastPrunedToolResults = 0;
				persistState(pi, state);
				updateStatus(ctx, state);
				ctx.ui.notify("Session pruning TTL expired. The next eligible request can prune again.", "info");
				return;
			}

			showRuntimeSummary(ctx, state);
		},
	});
}
