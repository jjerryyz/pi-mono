/**
 * Health App Memory Extension
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

const MEMORY_DIR = path.join(os.homedir(), ".pi", "health-app-memory");
const MEMORY_FILE = path.join(MEMORY_DIR, "MEMORY.md");
const MAX_AUTO_INJECT_CHARS = 3000;
const HEALTH_MEMORY_GUIDANCE = [
	"This assistant supports health app queries about sleep, blood oxygen, heart rate, steps, running, hiking, workouts, health records, and indicator trends.",
	"Use memory to retain durable health context that helps future data lookup and interpretation, such as profile details, age range, sex when explicitly shared, chronic conditions, injuries, medications, devices, measurement habits, baseline metrics, target ranges, recurring symptoms, exercise routines, report preferences, family history, physical exam findings, diet habits, menstrual cycle notes, and follow-up plans.",
	"Before answering questions about personalized baselines, historical trends, anomalies, preferred comparison windows, or previously shared health context, search memory first.",
	"Prefer saving stable facts and recurring patterns instead of one-off raw measurements unless they are explicitly important for follow-up analysis.",
];
const HEALTH_CATEGORY_EXAMPLES = [
	"profile",
	"baseline",
	"goal",
	"trend",
	"metric",
	"activity",
	"symptom",
	"record",
	"report",
	"family-history",
	"lifestyle",
	"follow-up",
	"device",
	"preference",
];
const HEALTH_QUERY_SYNONYMS: Record<string, string[]> = {
	sleep: ["sleep", "nap", "bedtime", "wake", "rest", "睡眠", "小睡", "入睡", "起床", "休息"],
	"sleep score": ["sleep score", "sleep quality", "sleep efficiency", "睡眠评分", "睡眠质量", "睡眠效率"],
	"blood oxygen": ["blood oxygen", "spo2", "oxygen saturation", "oxygen", "血氧", "血氧饱和度", "氧饱和度"],
	"heart rate": ["heart rate", "pulse", "hr", "resting heart rate", "心率", "脉搏", "静息心率"],
	run: ["run", "running", "jog", "jogging", "pace", "distance", "cadence", "跑步", "慢跑", "配速", "距离", "步频"],
	hike: [
		"hike",
		"hiking",
		"trek",
		"climb",
		"mountain",
		"trail",
		"elevation",
		"徒步",
		"登山",
		"爬山",
		"爬升",
		"海拔",
		"路线",
	],
	walk: ["walk", "walking", "steps", "step count", "activity", "步行", "走路", "步数", "活动量"],
	workout: ["workout", "exercise", "training", "fitness", "session", "锻炼", "运动", "训练", "健身", "训练记录"],
	record: [
		"record",
		"health record",
		"medical record",
		"archive",
		"history",
		"健康档案",
		"健康记录",
		"病历",
		"病史",
		"档案",
	],
	report: ["report", "exam", "checkup", "physical exam", "lab report", "体检", "化验", "报告"],
	metric: [
		"metric",
		"indicator",
		"biomarker",
		"measurement",
		"reading",
		"指标",
		"检测指标",
		"生物标志物",
		"测量值",
		"读数",
	],
	baseline: ["baseline", "usual", "normal", "typical", "基线", "平时水平", "正常水平", "典型水平"],
	trend: [
		"trend",
		"change",
		"comparison",
		"compare",
		"weekly",
		"monthly",
		"趋势",
		"变化",
		"对比",
		"比较",
		"周趋势",
		"月趋势",
	],
	symptom: ["symptom", "fatigue", "dizziness", "pain", "discomfort", "症状", "疲劳", "头晕", "疼痛", "不适"],
	diet: ["diet", "meal", "nutrition", "calorie", "protein", "饮食", "营养", "热量", "蛋白质", "饮食习惯"],
	family: ["family history", "family", "genetic", "遗传", "家族史", "家族病史"],
	cycle: ["period", "menstrual", "cycle", "经期", "月经", "周期", "生理期"],
	followup: ["follow-up", "review", "recheck", "appointment", "复诊", "复查", "随访", "预约"],
	device: [
		"device",
		"watch",
		"band",
		"wearable",
		"sensor",
		"apple watch",
		"设备",
		"手表",
		"手环",
		"穿戴设备",
		"传感器",
	],
};
const DEFAULT_HEALTH_MEMORY_TEMPLATE = `# Health Memory

## Health Profile
- Age range:
- Biological sex (only if user explicitly shared it):
- Height:
- Weight / weight trend:
- Primary goals:

## Health Records
- Chronic conditions:
- Past surgeries or injuries:
- Medications or supplements:
- Allergies or contraindications:

## Family History
- Cardiovascular history:
- Diabetes / metabolic history:
- Other relevant family conditions:

## Physical Exam And Reports
- Recent physical exam date:
- Important abnormal findings:
- Lab report highlights:
- Imaging / specialist conclusions:

## Devices And Data Sources
- Wearables / apps:
- Preferred source of truth:
- Measurement habits:

## Indicator Baselines
### Sleep
- Typical bedtime / wake time:
- Average sleep duration:
- Sleep quality baseline:

### Blood Oxygen
- Typical SpO2 range:
- Situations that affect readings:

### Heart Rate
- Resting heart rate baseline:
- Exercise heart rate notes:

### Activity
- Typical daily steps:
- Weekly exercise frequency:
- Common activity types:

## Activity Preferences
- Running habits:
- Hiking / climbing habits:
- Pace, distance, elevation preferences:
- Recovery expectations:

## Diet And Lifestyle
- Dietary pattern:
- Foods or habits that affect indicators:
- Caffeine / alcohol / smoking notes:
- Hydration and recovery habits:

## Symptoms And Patterns
- Recurring symptoms:
- Known triggers:
- Recovery patterns:

## Menstrual Or Cycle Notes
- Cycle tracking status:
- Typical cycle pattern:
- Cycle-related symptoms or performance changes:

## Query Preferences
- Preferred comparison window:
- Preferred summary style:
- Alert thresholds the user cares about:

## Follow-up Plan
- Planned rechecks or appointments:
- Metrics that need continued monitoring:
- Escalation conditions to watch:

## Open Questions
- Facts that still need confirmation:
`;

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

function expandHealthKeywords(query: string): string[] {
	const normalizedQuery = query.toLowerCase();
	const expanded = new Set(normalizedQuery.split(/\s+/).filter(Boolean));

	for (const synonyms of Object.values(HEALTH_QUERY_SYNONYMS)) {
		if (synonyms.some((term) => normalizedQuery.includes(term))) {
			for (const synonym of synonyms) {
				expanded.add(synonym);
			}
		}
	}

	return Array.from(expanded);
}

function extractMemoryChunks(
	file: string,
	content: string,
): Array<{ file: string; line: number; text: string; heading: string }> {
	const lines = content.split("\n");
	const chunks: Array<{ file: string; line: number; text: string; heading: string }> = [];
	let currentLines: string[] = [];
	let currentHeading = file === "MEMORY.md" ? "MEMORY.md" : "Daily log";
	let currentStartLine = 1;

	const pushChunk = () => {
		if (currentLines.length === 0) return;
		const text = currentLines.join("\n").trim();
		if (!text) return;
		chunks.push({
			file,
			line: currentStartLine,
			text,
			heading: currentHeading,
		});
	};

	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith("### ")) {
			pushChunk();
			currentHeading = lines[i].slice(4).trim();
			currentStartLine = i + 1;
			currentLines = [lines[i]];
			continue;
		}
		currentLines.push(lines[i]);
	}

	pushChunk();

	if (chunks.length === 0 && content.trim()) {
		chunks.push({
			file,
			line: 1,
			text: content.trim(),
			heading: file === "MEMORY.md" ? "MEMORY.md" : "Daily log",
		});
	}

	return chunks;
}

function hasLongTermMemory(): boolean {
	const content = readSafe(MEMORY_FILE);
	return Boolean(content?.trim());
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
		} else {
			sections.push(
				`### Suggested Long-term Memory Template\n[No MEMORY.md found yet. Use memory_template to get a health-focused template, then use memory_curate to save it.]`,
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

		return {
			systemPrompt:
				event.systemPrompt +
				"\n\n## Health Memory Policy\n\n" +
				HEALTH_MEMORY_GUIDANCE.map((line) => `- ${line}`).join("\n") +
				(sections.length > 0
					? "\n\n## Memory Context\n\n" +
						"The following memories were loaded from persistent storage (~/.pi/memory/).\n" +
						"Use memory_search for older entries not shown here.\n\n" +
						sections.join("\n\n")
					: ""),
		};
	});

	// ------------------------------------------------------------------
	// Tool: memory_template
	// ------------------------------------------------------------------

	pi.registerTool({
		name: "memory_template",
		label: "Memory Template",
		description:
			"Return a health-focused MEMORY.md template. Use this when long-term memory has not been initialized yet, " +
			"or when you want a clean structure for health profile facts, baselines, goals, devices, symptoms, and preferences.",
		promptSnippet: "memory_template - Get a health memory scaffold",
		promptGuidelines: [
			"When MEMORY.md is missing or sparse, fetch this template first.",
			"After filling in confirmed user facts, use memory_curate to write the organized long-term memory.",
		],
		parameters: Type.Object({}),

		async execute() {
			return {
				content: [{ type: "text", text: DEFAULT_HEALTH_MEMORY_TEMPLATE }],
				details: {
					hasLongTermMemory: hasLongTermMemory(),
					lines: DEFAULT_HEALTH_MEMORY_TEMPLATE.split("\n").length,
				},
			};
		},

		renderCall(_args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("memory_template"))} ${theme.fg("dim", "health scaffold")}`,
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as { hasLongTermMemory?: boolean; lines?: number } | undefined;
			const status = details?.hasLongTermMemory ? "template returned" : "template returned (MEMORY.md missing)";
			return new Text(
				`${theme.fg("success", "\u2713 ")}${theme.fg("muted", `${status}${details?.lines ? `, ${details.lines} lines` : ""}`)}`,
				0,
				0,
			);
		},
	});

	// ------------------------------------------------------------------
	// Tool: memory_save
	// ------------------------------------------------------------------

	pi.registerTool({
		name: "memory_save",
		label: "Memory Save",
		description:
			"Append a memory entry to today's daily log. Use this to persist durable health context, " +
			"user profile details, baselines, goals, preferences, and any health facts needed across sessions.",
		promptSnippet: "memory_save - Persist durable health memory to daily log",
		promptGuidelines: [
			"Proactively save stable health facts and preferences that should influence future health data queries and explanations.",
			"Good memory candidates include profile facts, chronic conditions shared by the user, devices/data sources, baseline indicators, target ranges, exercise habits, recurring symptoms, and preferred comparison windows.",
			"Also save stable context from physical exam reports, family history, lifestyle habits, menstrual or cycle patterns when relevant, and follow-up plans if they will affect future interpretation.",
			"Be concise but include enough context to be useful when recalled later.",
			`Include a category for better searchability (e.g., ${HEALTH_CATEGORY_EXAMPLES.join(", ")}).`,
		],
		parameters: Type.Object({
			content: Type.String({
				description:
					"The memory content to save. Use markdown. Include health-relevant context such as metric names, baselines, time ranges, devices, or user goals when applicable.",
			}),
			category: Type.Optional(
				Type.String({
					description: `Optional category (e.g., ${HEALTH_CATEGORY_EXAMPLES.join(", ")})`,
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
			"Search through all memory files (MEMORY.md + daily logs) for relevant health context. " +
			"Mandatory recall step before answering questions about prior baselines, trends, records, " +
			"symptoms, devices, preferences, or health goals.",
		promptSnippet: "memory_search - Search persistent health memory for prior context",
		promptGuidelines: [
			"Before answering about prior baselines, trends, records, symptoms, devices, goals, or preferences: search memory first.",
			"Use health terms in queries when relevant, such as sleep, blood oxygen, running, hiking, health record, report, metric, baseline, family history, diet, or symptom.",
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
			const keywords = expandHealthKeywords(query);
			const results: Array<{ file: string; line: number; text: string; heading: string; score: number }> = [];

			const files = listMemoryFiles();

			for (const file of files) {
				const filepath = path.join(MEMORY_DIR, file);
				const content = readSafe(filepath);
				if (!content) continue;

				const chunks = extractMemoryChunks(file, content);
				for (const chunk of chunks) {
					const chunkLower = chunk.text.toLowerCase();
					const headingLower = chunk.heading.toLowerCase();
					let score = 0;
					if (chunkLower.includes(query)) score += 4;
					if (headingLower.includes(query)) score += 3;

					score += keywords.reduce((sum, keyword) => {
						let keywordScore = 0;
						if (chunkLower.includes(keyword)) keywordScore += 1;
						if (headingLower.includes(keyword)) keywordScore += 2;
						return sum + keywordScore;
					}, 0);

					if (score > 0) {
						results.push({
							file,
							line: chunk.line,
							text: chunk.text,
							heading: chunk.heading,
							score,
						});
					}
				}
			}

			results.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line);
			const top = results.slice(0, maxResults);

			if (top.length === 0) {
				return {
					content: [{ type: "text", text: `No results found for "${params.query}"` }],
					details: { query: params.query, count: 0 },
				};
			}

			const text = top.map((r) => `--- ${r.file}:${r.line} [${r.heading}] ---\n${r.text}`).join("\n\n");
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
			"Use this to maintain a clean, organized summary of durable health profile facts, baselines, goals, devices, and preferences. " +
			"Unlike memory_save (which appends to daily logs), this overwrites MEMORY.md entirely.",
		promptSnippet: "memory_curate - Write structured long-term health memory",
		promptGuidelines: [
			"Prefer a structured document with stable sections such as Health Profile, Records, Family History, Physical Exam And Reports, Devices, Baselines, Activity Preferences, Diet And Lifestyle, Symptoms, Cycle Notes, Follow-up Plan, and Query Preferences.",
			"If MEMORY.md does not exist yet, use memory_template first unless you already know the exact structure you want.",
		],
		parameters: Type.Object({
			content: Type.String({
				description:
					"Full markdown content for MEMORY.md. Prefer stable sections such as Health Profile, Baselines, Goals, Devices, Records, Family History, Reports, Lifestyle, Symptoms, Cycle Notes, and Preferences. Use memory_template if you need a scaffold.",
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
		description: "Show health memory files",
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
