/**
 * Ralph Extension - Autonomous PRD-driven agent loop
 *
 * Implements the Ralph pattern (https://ghuntley.com/ralph/) as a pi extension.
 * Repeatedly drives the agent to implement user stories from a PRD, one per
 * iteration, until all stories pass or max iterations are reached.
 *
 * Memory between iterations is maintained via:
 * - progress.txt: append-only log of learnings and patterns
 * - Git history: commits from prior iterations
 * - Session context: pi's built-in compaction preserves key context
 *
 * Usage:
 *   pi --extension examples/extensions/ralph/index.ts
 *   /ralph start [prd-path] [max-iterations]
 *   /ralph stop
 *   /ralph status
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

// ============================================================================
// Types
// ============================================================================

interface PrdStory {
	id: string;
	title: string;
	description: string;
	acceptanceCriteria: string[];
	priority: number;
	passes: boolean;
	notes: string;
}

interface Prd {
	project: string;
	branchName: string;
	description: string;
	userStories: PrdStory[];
}

interface RalphState {
	active: boolean;
	prdPath: string;
	progressPath: string;
	iteration: number;
	maxIterations: number;
}

// ============================================================================
// Helpers
// ============================================================================

function readPrd(prdPath: string): Prd | null {
	try {
		return JSON.parse(fs.readFileSync(prdPath, "utf-8")) as Prd;
	} catch {
		return null;
	}
}

function writePrd(prdPath: string, prd: Prd): boolean {
	try {
		fs.writeFileSync(prdPath, `${JSON.stringify(prd, null, 2)}\n`, "utf-8");
		return true;
	} catch {
		return false;
	}
}

function getNextStory(prd: Prd): PrdStory | null {
	const incomplete = prd.userStories.filter((s) => !s.passes);
	if (incomplete.length === 0) return null;
	return incomplete.sort((a, b) => a.priority - b.priority)[0];
}

function formatStoryLine(s: PrdStory): string {
	const icon = s.passes ? "\u2713" : "\u25CB";
	return `${icon} [${s.id}] ${s.title} (p${s.priority})`;
}

function buildSystemPrompt(prd: Prd, prdPath: string, progressPath: string): string {
	const storiesBlock = prd.userStories
		.map((s) => {
			const status = s.passes ? "DONE" : "TODO";
			const criteria = s.acceptanceCriteria.map((c) => `  - ${c}`).join("\n");
			return [
				`[${status}] ${s.id} (priority ${s.priority}): ${s.title}`,
				s.description,
				"Acceptance criteria:",
				criteria,
				s.notes ? `Notes: ${s.notes}` : "",
			]
				.filter(Boolean)
				.join("\n");
		})
		.join("\n\n");

	return `

## Ralph Autonomous Agent Mode

You are operating in Ralph mode - an autonomous coding agent loop working through
user stories from a PRD, one story per iteration.

### Files
- PRD: ${prdPath}
- Progress log: ${progressPath}

### Current PRD: ${prd.project}
${prd.description}
Branch: ${prd.branchName}

### Stories
${storiesBlock}

### Workflow (each iteration)
1. Read progress.txt - check the Codebase Patterns section for learnings from prior iterations
2. Ensure you're on the correct git branch: \`${prd.branchName}\`. Create from main if it doesn't exist.
3. Pick the highest-priority story where passes is false
4. Implement that single story
5. Run quality checks (typecheck, lint, test as appropriate for the project)
6. If checks pass, commit changes: \`feat: [Story ID] - [Story Title]\`
7. Use the ralph_mark_story tool to set passes: true for the completed story
8. Append progress to progress.txt in this format:

\`\`\`
## [Date/Time] - [Story ID]
- What was implemented
- Files changed
- Learnings for future iterations:
  - Patterns discovered
  - Gotchas encountered
  - Useful context
---
\`\`\`

9. If you discover reusable patterns, add them to the Codebase Patterns section at the TOP of progress.txt

### Rules
- Work on ONE story per iteration
- Keep changes focused and minimal
- Follow existing code patterns in the project
- ALL commits must pass quality checks
- Do NOT commit broken code
- After completing the story and updating progress, end your response
`;
}

function buildIterationMessage(prd: Prd, iteration: number, maxIterations: number, progressPath: string): string {
	const next = getNextStory(prd);
	const incomplete = prd.userStories.filter((s) => !s.passes).length;

	let msg = `Ralph iteration ${iteration}/${maxIterations}. ${incomplete} story(ies) remaining.`;
	if (next) {
		msg += ` Next: [${next.id}] ${next.title} (priority ${next.priority}).`;
	}
	msg += ` Read ${progressPath} first, then implement the next story.`;
	return msg;
}

// ============================================================================
// Extension
// ============================================================================

export default function ralphExtension(pi: ExtensionAPI) {
	const state: RalphState = {
		active: false,
		prdPath: "",
		progressPath: "",
		iteration: 0,
		maxIterations: 10,
	};

	// ------------------------------------------------------------------
	// Command: /ralph [start|stop|status]
	// ------------------------------------------------------------------

	pi.registerCommand("ralph", {
		description: "Ralph agent loop: /ralph [start|stop|status] [prd-path] [max-iterations]",
		getArgumentCompletions: (prefix) => {
			const cmds = ["start", "stop", "status"];
			const filtered = cmds.filter((c) => c.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((c) => ({ value: c, label: c })) : null;
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const subcommand = parts[0] || "start";

			switch (subcommand) {
				case "start": {
					if (state.active) {
						ctx.ui.notify(
							`Ralph already running (iteration ${state.iteration}/${state.maxIterations}). Use /ralph stop first.`,
							"warning",
						);
						return;
					}

					const prdArg = parts[1];
					const maxIter = parts[2] ? parseInt(parts[2], 10) : 10;
					const prdPath = prdArg ? path.resolve(ctx.cwd, prdArg) : path.join(ctx.cwd, "prd.json");

					if (!fs.existsSync(prdPath)) {
						ctx.ui.notify(`PRD not found: ${prdPath}`, "error");
						return;
					}

					state.prdPath = prdPath;
					state.progressPath = path.join(path.dirname(prdPath), "progress.txt");
					state.maxIterations = maxIter;
					state.iteration = 0;

					if (!fs.existsSync(state.progressPath)) {
						fs.writeFileSync(
							state.progressPath,
							`# Ralph Progress Log\nStarted: ${new Date().toISOString()}\n---\n`,
							"utf-8",
						);
					}

					const prd = readPrd(prdPath);
					if (!prd) {
						ctx.ui.notify("Failed to parse PRD", "error");
						return;
					}

					const allDone = prd.userStories.every((s) => s.passes);
					if (allDone) {
						ctx.ui.notify("All stories already complete", "info");
						return;
					}

					state.active = true;
					state.iteration = 1;

					const incomplete = prd.userStories.filter((s) => !s.passes).length;
					ctx.ui.notify(
						`Ralph started: ${prd.project} (${incomplete} stories, max ${maxIter} iterations)`,
						"info",
					);

					pi.setSessionName(`Ralph: ${prd.project}`);
					pi.sendUserMessage(buildIterationMessage(prd, state.iteration, state.maxIterations, state.progressPath));
					break;
				}

				case "stop": {
					if (!state.active) {
						ctx.ui.notify("Ralph is not running", "info");
						return;
					}
					state.active = false;
					ctx.ui.notify(`Ralph stopped after ${state.iteration} iteration(s)`, "info");
					break;
				}

				case "status": {
					const prdPath = state.prdPath || path.join(ctx.cwd, "prd.json");
					if (!fs.existsSync(prdPath)) {
						ctx.ui.notify("No PRD found", "info");
						return;
					}

					const prd = readPrd(prdPath);
					if (!prd) {
						ctx.ui.notify("Failed to parse PRD", "error");
						return;
					}

					const complete = prd.userStories.filter((s) => s.passes).length;
					const total = prd.userStories.length;
					const runStatus = state.active
						? `running (iteration ${state.iteration}/${state.maxIterations})`
						: "stopped";

					const lines = [
						`Project: ${prd.project}`,
						`Branch:  ${prd.branchName}`,
						`Ralph:   ${runStatus}`,
						`Progress: ${complete}/${total}`,
						"",
						...prd.userStories.map(formatStoryLine),
					];
					ctx.ui.notify(lines.join("\n"), "info");
					break;
				}

				default:
					ctx.ui.notify("Usage: /ralph [start|stop|status] [prd-path] [max-iterations]", "info");
			}
		},
	});

	// ------------------------------------------------------------------
	// System prompt injection
	// ------------------------------------------------------------------

	pi.on("before_agent_start", async (event) => {
		if (!state.active) return;
		const prd = readPrd(state.prdPath);
		if (!prd) return;
		return {
			systemPrompt: event.systemPrompt + buildSystemPrompt(prd, state.prdPath, state.progressPath),
		};
	});

	// ------------------------------------------------------------------
	// Auto-continuation on agent_end
	// ------------------------------------------------------------------

	pi.on("agent_end", async (_event, ctx) => {
		if (!state.active) return;

		const prd = readPrd(state.prdPath);
		if (!prd) {
			state.active = false;
			ctx.ui.notify("Ralph: failed to read PRD, stopping", "error");
			return;
		}

		const allDone = prd.userStories.every((s) => s.passes);
		if (allDone) {
			state.active = false;
			ctx.ui.notify(`Ralph: all stories complete! Finished in ${state.iteration} iteration(s).`, "info");
			return;
		}

		if (state.iteration >= state.maxIterations) {
			state.active = false;
			const remaining = prd.userStories.filter((s) => !s.passes).length;
			ctx.ui.notify(
				`Ralph: max iterations reached (${state.maxIterations}). ${remaining} story(ies) remaining. Use /ralph start to resume.`,
				"warning",
			);
			return;
		}

		state.iteration++;
		const incomplete = prd.userStories.filter((s) => !s.passes).length;
		ctx.ui.notify(`Ralph: iteration ${state.iteration}/${state.maxIterations} (${incomplete} remaining)`, "info");
		pi.sendUserMessage(buildIterationMessage(prd, state.iteration, state.maxIterations, state.progressPath), {
			deliverAs: "followUp",
		});
	});

	// ------------------------------------------------------------------
	// Tool: ralph_mark_story
	// ------------------------------------------------------------------

	pi.registerTool({
		name: "ralph_mark_story",
		label: "Ralph Mark Story",
		description:
			"Mark a user story in the PRD as passed or failed. " +
			"Use after implementing and verifying a story to update its status.",
		promptSnippet: "ralph_mark_story - Mark a PRD story as passed/failed",
		parameters: Type.Object({
			story_id: Type.String({ description: "The story ID (e.g., 'US-001')" }),
			passes: Type.Boolean({ description: "true if the story passes, false if it fails" }),
			notes: Type.Optional(Type.String({ description: "Optional notes about the implementation" })),
		}),

		async execute(_toolCallId, params) {
			const prd = readPrd(state.prdPath);
			if (!prd) {
				return {
					content: [{ type: "text" as const, text: "No PRD loaded" }],
					details: undefined,
					isError: true,
				};
			}

			const story = prd.userStories.find((s) => s.id === params.story_id);
			if (!story) {
				const ids = prd.userStories.map((s) => s.id).join(", ");
				return {
					content: [
						{
							type: "text" as const,
							text: `Story not found: ${params.story_id}. Available: ${ids}`,
						},
					],
					details: undefined,
					isError: true,
				};
			}

			story.passes = params.passes;
			if (params.notes !== undefined) story.notes = params.notes;

			if (!writePrd(state.prdPath, prd)) {
				return {
					content: [{ type: "text" as const, text: "Failed to write PRD" }],
					details: undefined,
					isError: true,
				};
			}

			const complete = prd.userStories.filter((s) => s.passes).length;
			const total = prd.userStories.length;
			const allDone = complete === total;

			return {
				content: [
					{
						type: "text" as const,
						text: `${story.id} marked as ${params.passes ? "passed" : "failed"}. Progress: ${complete}/${total}${allDone ? " - ALL COMPLETE" : ""}`,
					},
				],
				details: {
					storyId: params.story_id,
					passes: params.passes,
					complete,
					total,
					allDone,
				},
			};
		},

		renderCall(args, theme) {
			const icon = args.passes ? theme.fg("success", "\u2713") : theme.fg("error", "\u2717");
			return new Text(
				`${theme.fg("toolTitle", theme.bold("ralph_mark_story"))} ${icon} ${theme.fg("accent", String(args.story_id))}`,
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as
				| { passes: boolean; complete: number; total: number; allDone: boolean }
				| undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? theme.fg("error", text.text) : "", 0, 0);
			}
			const icon = details.passes ? theme.fg("success", "\u2713") : theme.fg("error", "\u2717");
			const progress = theme.fg("muted", `${details.complete}/${details.total}`);
			const done = details.allDone ? theme.fg("success", " ALL COMPLETE") : "";
			return new Text(`${icon} ${progress}${done}`, 0, 0);
		},
	});

	// ------------------------------------------------------------------
	// Tool: ralph_status
	// ------------------------------------------------------------------

	pi.registerTool({
		name: "ralph_status",
		label: "Ralph Status",
		description: "Check current completion status of all user stories in the PRD.",
		promptSnippet: "ralph_status - View PRD story completion status",
		parameters: Type.Object({}),

		async execute() {
			const prd = readPrd(state.prdPath);
			if (!prd) {
				return {
					content: [
						{
							type: "text" as const,
							text: "No PRD loaded. Start Ralph with /ralph start.",
						},
					],
					details: undefined,
				};
			}

			const complete = prd.userStories.filter((s) => s.passes).length;
			const total = prd.userStories.length;
			const text = [
				`Project: ${prd.project}`,
				`Branch: ${prd.branchName}`,
				`Progress: ${complete}/${total}`,
				"",
				...prd.userStories.map(formatStoryLine),
			].join("\n");

			return {
				content: [{ type: "text" as const, text }],
				details: { project: prd.project, complete, total },
			};
		},

		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("ralph_status")), 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as { complete: number; total: number } | undefined;
			if (!details) {
				return new Text(theme.fg("muted", "No PRD loaded"), 0, 0);
			}
			const icon = details.complete === details.total ? theme.fg("success", "\u2713") : theme.fg("accent", "\u25CB");
			return new Text(`${icon} ${theme.fg("muted", `${details.complete}/${details.total} stories complete`)}`, 0, 0);
		},
	});

	// ------------------------------------------------------------------
	// Tool: ralph_append_progress
	// ------------------------------------------------------------------

	pi.registerTool({
		name: "ralph_append_progress",
		label: "Ralph Append Progress",
		description:
			"Append a progress entry to the Ralph progress log. " +
			"Use after completing a story to record what was done and any learnings.",
		promptSnippet: "ralph_append_progress - Log iteration progress and learnings",
		parameters: Type.Object({
			story_id: Type.String({ description: "The story ID that was worked on" }),
			content: Type.String({
				description:
					"Progress entry in markdown. Include: what was implemented, files changed, and learnings for future iterations.",
			}),
		}),

		async execute(_toolCallId, params) {
			if (!state.progressPath) {
				return {
					content: [{ type: "text" as const, text: "No progress file configured" }],
					details: undefined,
					isError: true,
				};
			}

			const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
			const entry = `\n## ${timestamp} - ${params.story_id}\n${params.content}\n---\n`;

			try {
				fs.appendFileSync(state.progressPath, entry, "utf-8");
			} catch {
				return {
					content: [{ type: "text" as const, text: "Failed to write progress file" }],
					details: undefined,
					isError: true,
				};
			}

			return {
				content: [
					{
						type: "text" as const,
						text: `Progress logged for ${params.story_id}`,
					},
				],
				details: { storyId: params.story_id },
			};
		},

		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("ralph_append_progress"))} ${theme.fg("accent", String(args.story_id))}`,
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as { storyId: string } | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(theme.fg("error", text?.type === "text" ? text.text : "Error"), 0, 0);
			}
			return new Text(`${theme.fg("success", "\u2713")} ${theme.fg("muted", "Progress logged")}`, 0, 0);
		},
	});
}
