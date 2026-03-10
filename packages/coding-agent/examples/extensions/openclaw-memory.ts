/**
 * Memory Extension
 *
 * Persistent memory system inspired by openclaw. Stores memories as plain
 * Markdown files and provides tools for the LLM to save/search/read them.
 *
 * Storage layout (~/.pi/memory/):
 * - MEMORY.md            — Long-term curated memory (manually edited or via memory_curate)
 * - YYYY-MM-DD.md        — Daily append-only logs
 *
 * Tools:
 * - memory_save   — Append a timestamped entry to today's daily log
 * - memory_search — Keyword search across all memory files
 * - memory_read   — Read a specific memory file (with optional line range)
 * - memory_curate — Write/replace content in MEMORY.md for long-term storage
 *
 * Commands:
 * - /memory       — List memory files and show recent entries
 *
 * System prompt integration:
 * - Injects today's + yesterday's notes and MEMORY.md (if small) via before_agent_start
 * - Adds prompt guidelines telling the model when to use memory tools
 *
 * Usage:
 * 1. Copy to ~/.pi/agent/extensions/ or your project's .pi/extensions/
 * 2. Or load with: pi --extension path/to/memory.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";

const MEMORY_DIR = path.join(os.homedir(), ".pi", "openclaw-memory");
const MEMORY_FILE = path.join(MEMORY_DIR, "MEMORY.md");
const MAX_AUTO_INJECT_CHARS = 3000;

function ensureDir(): void {
	fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

function dateStr(date: Date): string {
	const yyyy = date.getFullYear();
	const mm = String(date.getMonth() + 1).padStart(2, "0");
	const dd = String(date.getDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}

function todayFile(): string {
	return path.join(MEMORY_DIR, `${dateStr(new Date())}.md`);
}

function yesterdayFile(): string {
	const d = new Date();
	d.setDate(d.getDate() - 1);
	return path.join(MEMORY_DIR, `${dateStr(d)}.md`);
}

function readSafe(filepath: string): string | null {
	try {
		return fs.readFileSync(filepath, "utf-8");
	} catch {
		return null;
	}
}

function listMemoryFiles(): string[] {
	ensureDir();
	try {
		return fs
			.readdirSync(MEMORY_DIR)
			.filter((f) => f.endsWith(".md"))
			.sort()
			.reverse();
	} catch {
		return [];
	}
}

// ============================================================================
// Memory List UI Component
// ============================================================================

class MemoryListComponent {
	private files: string[];
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(files: string[], theme: Theme, onClose: () => void) {
		this.files = files;
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

		const lines: string[] = [];
		const th = this.theme;

		lines.push("");
		const title = th.fg("accent", " Memory Files ");
		const headerLine =
			th.fg("borderMuted", "\u2500".repeat(3)) +
			title +
			th.fg("borderMuted", "\u2500".repeat(Math.max(0, width - 18)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		if (this.files.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No memory files yet.")}`, width));
		} else {
			lines.push(truncateToWidth(`  ${th.fg("muted", `${this.files.length} file(s) in ~/.pi/memory/`)}`, width));
			lines.push("");

			for (const file of this.files) {
				const isLongTerm = file === "MEMORY.md";
				const icon = isLongTerm ? th.fg("accent", "\u2605") : th.fg("dim", "\u2022");
				const label = isLongTerm ? th.fg("accent", file) : th.fg("text", file);
				const filepath = path.join(MEMORY_DIR, file);
				let size = "";
				try {
					const stat = fs.statSync(filepath);
					size = th.fg("dim", ` (${formatBytes(stat.size)})`);
				} catch {
					/* ignore */
				}
				lines.push(truncateToWidth(`  ${icon} ${label}${size}`, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ============================================================================
// Extension
// ============================================================================

export default function memoryExtension(pi: ExtensionAPI) {
	ensureDir();

	// ------------------------------------------------------------------
	// System prompt: inject recent memories + recall instructions
	// ------------------------------------------------------------------

	pi.on("before_agent_start", async (event) => {
		const sections: string[] = [];

		const longTerm = readSafe(MEMORY_FILE);
		if (longTerm?.trim() && longTerm.length <= MAX_AUTO_INJECT_CHARS) {
			sections.push(`### Long-term Memory (MEMORY.md)\n${longTerm.trim()}`);
		} else if (longTerm?.trim()) {
			sections.push(
				"### Long-term Memory (MEMORY.md)\n[File too large to auto-inject. Use memory_read to access it.]",
			);
		}

		const todayContent = readSafe(todayFile());
		if (todayContent?.trim() && todayContent.length <= MAX_AUTO_INJECT_CHARS) {
			sections.push(`### Today (${dateStr(new Date())})\n${todayContent.trim()}`);
		} else if (todayContent?.trim()) {
			sections.push(
				`### Today (${dateStr(new Date())})\n[File too large to auto-inject. Use memory_read to access it.]`,
			);
		}

		const yesterdayContent = readSafe(yesterdayFile());
		if (yesterdayContent?.trim() && yesterdayContent.length <= MAX_AUTO_INJECT_CHARS) {
			const d = new Date();
			d.setDate(d.getDate() - 1);
			sections.push(`### Yesterday (${dateStr(d)})\n${yesterdayContent.trim()}`);
		}

		if (sections.length === 0) {
			return;
		}

		return {
			systemPrompt:
				event.systemPrompt +
				"\n\n## Memory Context\n\n" +
				"The following memories were loaded from persistent storage (~/.pi/memory/).\n" +
				"Use memory_search for older entries not shown here.\n\n" +
				sections.join("\n\n"),
		};
	});

	// ------------------------------------------------------------------
	// Tool: memory_save
	// ------------------------------------------------------------------

	pi.registerTool({
		name: "memory_save",
		label: "Memory Save",
		description:
			"Append a memory entry to today's daily log. Use this to persist important information, " +
			"decisions, user preferences, project context, or anything worth remembering across sessions.",
		promptSnippet: "memory_save - Persist durable memories to daily log",
		promptGuidelines: [
			"Proactively save important facts, decisions, preferences, and context that should persist across sessions.",
			"Be concise but include enough context to be useful when recalled later.",
			"Include a category for better searchability (e.g., preference, decision, context, todo, project).",
		],
		parameters: Type.Object({
			content: Type.String({
				description: "The memory content to save. Use markdown. Include relevant context.",
			}),
			category: Type.Optional(
				Type.String({
					description: "Optional category (e.g., preference, decision, context, todo, project)",
				}),
			),
		}),

		async execute(_toolCallId, params) {
			ensureDir();
			const filepath = todayFile();
			const timestamp = new Date().toLocaleTimeString("en-US", {
				hour12: false,
				hour: "2-digit",
				minute: "2-digit",
			});
			const category = params.category ? ` [${params.category}]` : "";
			const entry = `\n### ${timestamp}${category}\n\n${params.content}\n`;

			fs.appendFileSync(filepath, entry, "utf-8");

			return {
				content: [{ type: "text", text: `Memory saved to ${path.basename(filepath)}` }],
				details: { file: path.basename(filepath), category: params.category },
			};
		},

		renderCall(args, theme) {
			const cat = args.category ? theme.fg("accent", ` [${args.category}]`) : "";
			const preview = args.content.length > 60 ? `${args.content.slice(0, 60)}\u2026` : args.content;
			return new Text(`${theme.fg("toolTitle", theme.bold("memory_save")) + cat} ${theme.fg("dim", preview)}`, 0, 0);
		},

		renderResult(result, _options, theme) {
			const text = result.content[0];
			return new Text(
				theme.fg("success", "\u2713 ") + theme.fg("muted", text?.type === "text" ? text.text : ""),
				0,
				0,
			);
		},
	});

	// ------------------------------------------------------------------
	// Tool: memory_search
	// ------------------------------------------------------------------

	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description:
			"Search through all memory files (MEMORY.md + daily logs) for relevant information. " +
			"Mandatory recall step before answering questions about prior work, decisions, dates, " +
			"people, preferences, or todos.",
		promptSnippet: "memory_search - Search persistent memory for prior context",
		promptGuidelines: [
			"Before answering about prior work, decisions, dates, people, preferences, or todos: search memory first.",
			"If low confidence after search, say you checked but found nothing relevant.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search keywords or phrases" }),
			max_results: Type.Optional(Type.Number({ description: "Maximum results to return (default 10)" })),
		}),

		async execute(_toolCallId, params) {
			ensureDir();
			const query = params.query.toLowerCase();
			const maxResults = params.max_results ?? 10;
			const keywords = query.split(/\s+/).filter(Boolean);
			const results: Array<{ file: string; line: number; text: string; score: number }> = [];

			const files = listMemoryFiles();

			for (const file of files) {
				const filepath = path.join(MEMORY_DIR, file);
				const content = readSafe(filepath);
				if (!content) continue;

				const lines = content.split("\n");
				for (let i = 0; i < lines.length; i++) {
					const lineLower = lines[i].toLowerCase();
					const score = keywords.reduce((s, kw) => s + (lineLower.includes(kw) ? 1 : 0), 0);
					if (score > 0) {
						const start = Math.max(0, i - 2);
						const end = Math.min(lines.length, i + 3);
						const context = lines.slice(start, end).join("\n");
						results.push({ file, line: i + 1, text: context, score });
					}
				}
			}

			results.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
			const top = results.slice(0, maxResults);

			if (top.length === 0) {
				return {
					content: [{ type: "text", text: `No results found for "${params.query}"` }],
					details: { query: params.query, count: 0 },
				};
			}

			const text = top.map((r) => `--- ${r.file}:${r.line} ---\n${r.text}`).join("\n\n");
			return {
				content: [
					{
						type: "text",
						text: `Found ${top.length} result(s) for "${params.query}":\n\n${text}`,
					},
				],
				details: { query: params.query, count: top.length },
			};
		},

		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("memory_search"))} ${theme.fg("dim", `"${args.query}"`)}`,
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as { count: number } | undefined;
			const count = details?.count ?? 0;
			const msg = count > 0 ? `${count} result(s) found` : "No results";
			return new Text(
				count > 0 ? theme.fg("success", "\u2713 ") + theme.fg("muted", msg) : theme.fg("dim", msg),
				0,
				0,
			);
		},
	});

	// ------------------------------------------------------------------
	// Tool: memory_read
	// ------------------------------------------------------------------

	pi.registerTool({
		name: "memory_read",
		label: "Memory Read",
		description:
			"Read a specific memory file. Use after memory_search to get full context, " +
			"or to read MEMORY.md / a specific daily log.",
		parameters: Type.Object({
			file: Type.String({
				description: "Filename (e.g., 'MEMORY.md' or '2025-03-09.md')",
			}),
			from_line: Type.Optional(Type.Number({ description: "Start reading from this line (1-indexed)" })),
			lines: Type.Optional(Type.Number({ description: "Number of lines to read" })),
		}),

		async execute(_toolCallId, params) {
			const filepath = path.join(MEMORY_DIR, params.file);
			const content = readSafe(filepath);
			if (!content) {
				return {
					content: [{ type: "text" as const, text: `File not found: ${params.file}` }],
					details: { file: params.file, found: false, totalLines: 0 },
					isError: true,
				};
			}

			let fileLines = content.split("\n");
			const totalLines = fileLines.length;
			if (params.from_line !== undefined) {
				const start = Math.max(0, params.from_line - 1);
				const count = params.lines ?? fileLines.length;
				fileLines = fileLines.slice(start, start + count);
			}

			return {
				content: [{ type: "text", text: fileLines.join("\n") }],
				details: { file: params.file, found: true, totalLines },
			};
		},

		renderCall(args, theme) {
			let text = `${theme.fg("toolTitle", theme.bold("memory_read"))} ${theme.fg("accent", args.file)}`;
			if (args.from_line !== undefined) {
				text += theme.fg("dim", `:${args.from_line}`);
				if (args.lines !== undefined) text += theme.fg("dim", `+${args.lines}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as { found: boolean; totalLines?: number } | undefined;
			if (!details?.found) {
				return new Text(theme.fg("error", "File not found"), 0, 0);
			}
			return new Text(theme.fg("success", "\u2713 ") + theme.fg("muted", `${details.totalLines} lines`), 0, 0);
		},
	});

	// ------------------------------------------------------------------
	// Tool: memory_curate
	// ------------------------------------------------------------------

	pi.registerTool({
		name: "memory_curate",
		label: "Memory Curate",
		description:
			"Write or replace content in MEMORY.md (long-term curated memory). " +
			"Use this to maintain a clean, organized summary of the most important persistent facts. " +
			"Unlike memory_save (which appends to daily logs), this overwrites MEMORY.md entirely.",
		parameters: Type.Object({
			content: Type.String({
				description: "Full markdown content for MEMORY.md",
			}),
		}),

		async execute(_toolCallId, params) {
			ensureDir();
			fs.writeFileSync(MEMORY_FILE, params.content, "utf-8");

			return {
				content: [{ type: "text", text: "MEMORY.md updated" }],
				details: { lines: params.content.split("\n").length },
			};
		},

		renderCall(args, theme) {
			const lineCount = args.content.split("\n").length;
			return new Text(
				`${theme.fg("toolTitle", theme.bold("memory_curate"))} ${theme.fg("dim", `${lineCount} lines`)}`,
				0,
				0,
			);
		},

		renderResult(_result, _options, theme) {
			return new Text(`${theme.fg("success", "\u2713 ")}${theme.fg("muted", "MEMORY.md updated")}`, 0, 0);
		},
	});

	// ------------------------------------------------------------------
	// Command: /memory
	// ------------------------------------------------------------------

	pi.registerCommand("memory", {
		description: "Show memory files",
		handler: async (_args, ctx) => {
			const files = listMemoryFiles();

			if (!ctx.hasUI) {
				if (files.length === 0) {
					ctx.ui.notify("No memory files found.", "info");
				} else {
					ctx.ui.notify(`Memory files: ${files.join(", ")}`, "info");
				}
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new MemoryListComponent(files, theme, () => done());
			});
		},
	});
}
