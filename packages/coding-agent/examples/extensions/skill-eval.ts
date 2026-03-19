/**
 * Skill Eval Extension
 *
 * Test, benchmark, and compare skills with automated evaluations.
 * Inspired by Anthropic's skill-creator eval system.
 *
 * Place an evals.json file alongside SKILL.md in any skill directory:
 *
 *   my-skill/
 *     SKILL.md
 *     evals.json
 *
 * evals.json format:
 *   {
 *     "evals": [
 *       {
 *         "name": "basic test",
 *         "prompt": "user prompt to send",
 *         "criteria": ["criterion 1", "criterion 2"],
 *         "tools": true
 *       }
 *     ]
 *   }
 *
 * Commands:
 *   /skill-eval              - Interactive skill/action selector
 *   /skill-eval list         - List skills with evals
 *   /skill-eval run <name>   - Run evals for a specific skill
 *   /skill-eval benchmark    - Run all evals with summary
 *   /skill-eval compare <name> - A/B: with-skill vs without-skill
 *   /skill-eval tune <name>  - Analyze skill description for better triggering
 *
 * Usage:
 * 1. Copy this file to ~/.pi/agent/extensions/ or .pi/extensions/
 * 2. Create evals.json in your skill directories
 * 3. Use /skill-eval to run evaluations
 */

import { type AssistantMessage, complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
	createAgentSession,
	createExtensionRuntime,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { existsSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ============================================================================
// Types
// ============================================================================

interface EvalDefinition {
	name: string;
	prompt: string;
	criteria: string[];
	/** Whether to provide tools to the agent. Default: true */
	tools?: boolean;
}

interface SkillWithEvals {
	name: string;
	skillPath: string;
	skillDir: string;
	skillContent: string;
	evals: EvalDefinition[];
}

interface EvalResult {
	evalName: string;
	skillName: string;
	passed: boolean;
	score: number;
	feedback: string;
	responseSummary: string;
	elapsedMs: number;
	tokens: { input: number; output: number };
}

interface BenchmarkResult {
	skillName: string;
	totalEvals: number;
	passed: number;
	passRate: number;
	totalElapsedMs: number;
	totalTokens: { input: number; output: number };
	results: EvalResult[];
}

// ============================================================================
// Discovery
// ============================================================================

function discoverSkillsWithEvals(cwd: string): SkillWithEvals[] {
	const agentDir = join(homedir(), ".pi", "agent");
	const searchDirs = [join(agentDir, "skills"), join(cwd, ".pi", "skills")];

	const skills: SkillWithEvals[] = [];
	const seen = new Set<string>();

	for (const dir of searchDirs) {
		if (!existsSync(dir)) continue;

		try {
			const entries = readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
				if (seen.has(entry.name)) continue;

				const skillDir = join(dir, entry.name);
				const skillPath = join(skillDir, "SKILL.md");
				const evalsPath = join(skillDir, "evals.json");

				if (!existsSync(skillPath) || !existsSync(evalsPath)) continue;

				try {
					const skillContent = readFileSync(skillPath, "utf-8");
					const evalsContent = readFileSync(evalsPath, "utf-8");
					const evalFile = JSON.parse(evalsContent) as { evals?: EvalDefinition[] };

					if (evalFile.evals && evalFile.evals.length > 0) {
						seen.add(entry.name);
						skills.push({
							name: entry.name,
							skillPath,
							skillDir,
							skillContent,
							evals: evalFile.evals,
						});
					}
				} catch {
					// Skip malformed eval files
				}
			}
		} catch {
			// Skip inaccessible directories
		}
	}

	return skills;
}

// ============================================================================
// Eval Resource Loader
// ============================================================================

function createEvalResourceLoader(skillContent?: string): ResourceLoader {
	const base = "You are a helpful coding assistant.";
	const systemPrompt = skillContent
		? `${base}\n\nThe following skill provides specialized instructions:\n\n${skillContent}`
		: base;

	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => [],
		getPathMetadata: () => new Map(),
		extendResources: () => {},
		reload: async () => {},
	};
}

// ============================================================================
// Eval Runner
// ============================================================================

async function runSingleEval(
	evalDef: EvalDefinition,
	skillName: string,
	skillContent: string | undefined,
	model: any,
	modelRegistry: any,
	cwd: string,
): Promise<EvalResult> {
	const startTime = Date.now();
	let responseText = "";
	let inputTokens = 0;
	let outputTokens = 0;

	const resourceLoader = createEvalResourceLoader(skillContent);

	try {
		const { session } = await createAgentSession({
			cwd,
			model,
			thinkingLevel: "off",
			resourceLoader,
			tools: evalDef.tools === false ? [] : undefined,
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: false },
				retry: { enabled: false },
			}),
		});

		session.subscribe((event) => {
			if (event.type !== "message_update") return;
			const evt = event.assistantMessageEvent;
			if (evt.type === "text_delta") {
				responseText += evt.delta;
			}
			if (evt.type === "done") {
				inputTokens += evt.message.usage.input;
				outputTokens += evt.message.usage.output;
			}
		});

		await session.prompt(evalDef.prompt);
	} catch (error) {
		return {
			evalName: evalDef.name,
			skillName,
			passed: false,
			score: 0,
			feedback: `Session error: ${error instanceof Error ? error.message : String(error)}`,
			responseSummary: "",
			elapsedMs: Date.now() - startTime,
			tokens: { input: 0, output: 0 },
		};
	}

	const elapsedMs = Date.now() - startTime;

	const judgeResult = await judgeResponse(evalDef, responseText, model, modelRegistry);

	return {
		evalName: evalDef.name,
		skillName,
		passed: judgeResult.passed,
		score: judgeResult.score,
		feedback: judgeResult.feedback,
		responseSummary: responseText.length > 300 ? `${responseText.slice(0, 297)}...` : responseText,
		elapsedMs,
		tokens: { input: inputTokens, output: outputTokens },
	};
}

async function judgeResponse(
	evalDef: EvalDefinition,
	response: string,
	model: any,
	modelRegistry: any,
): Promise<{ passed: boolean; score: number; feedback: string }> {
	const apiKey = await modelRegistry.getApiKey(model);
	if (!apiKey) {
		return { passed: false, score: 0, feedback: "No API key for judge model" };
	}

	const criteriaList = evalDef.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");

	const judgePrompt = [
		"You are an eval judge. Evaluate the assistant's response against criteria.",
		"",
		"## Prompt",
		evalDef.prompt,
		"",
		"## Criteria",
		criteriaList,
		"",
		"## Response",
		response.slice(0, 4000),
		"",
		"## Instructions",
		"Output ONLY a JSON object (no markdown fences, no extra text):",
		'{"passed": true, "score": 85, "feedback": "brief explanation"}',
		'Set "passed" to true if all criteria are substantially met (score >= 70).',
	].join("\n");

	try {
		const result: AssistantMessage = await complete(
			model,
			{
				messages: [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: judgePrompt }],
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey },
		);

		const text = result.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("");

		const jsonMatch = text.match(/\{[\s\S]*?\}/);
		if (jsonMatch) {
			return JSON.parse(jsonMatch[0]);
		}
		return JSON.parse(text);
	} catch (error) {
		return {
			passed: false,
			score: 0,
			feedback: `Judge error: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

// ============================================================================
// Display Helpers
// ============================================================================

function formatResults(skillName: string, results: EvalResult[]): string {
	const passed = results.filter((r) => r.passed).length;
	const totalMs = results.reduce((sum, r) => sum + r.elapsedMs, 0);

	const lines: string[] = [
		`## Eval Results: ${skillName}`,
		"",
		`**${passed}/${results.length} passed** | ${(totalMs / 1000).toFixed(1)}s total`,
		"",
	];

	for (const r of results) {
		const icon = r.passed ? "PASS" : "FAIL";
		lines.push(`### [${icon}] ${r.evalName} (score: ${r.score}/100)`);
		lines.push(`- Time: ${(r.elapsedMs / 1000).toFixed(1)}s | Tokens: ${r.tokens.input}in / ${r.tokens.output}out`);
		lines.push(`- ${r.feedback}`);
		lines.push("");
	}

	return lines.join("\n");
}

function formatBenchmark(benchmarks: BenchmarkResult[]): string {
	const totalEvals = benchmarks.reduce((sum, b) => sum + b.totalEvals, 0);
	const totalPassed = benchmarks.reduce((sum, b) => sum + b.passed, 0);
	const totalMs = benchmarks.reduce((sum, b) => sum + b.totalElapsedMs, 0);
	const totalIn = benchmarks.reduce((sum, b) => sum + b.totalTokens.input, 0);
	const totalOut = benchmarks.reduce((sum, b) => sum + b.totalTokens.output, 0);
	const overallRate = totalEvals > 0 ? Math.round((totalPassed / totalEvals) * 100) : 0;

	const lines: string[] = [
		"## Benchmark Results",
		"",
		`**${totalPassed}/${totalEvals} passed** (${overallRate}%) | ${(totalMs / 1000).toFixed(1)}s | ${totalIn + totalOut} tokens`,
		"",
		"| Skill | Pass Rate | Time | Tokens |",
		"|-------|-----------|------|--------|",
	];

	for (const b of benchmarks) {
		lines.push(
			`| ${b.skillName} | ${b.passed}/${b.totalEvals} (${b.passRate}%) | ${(b.totalElapsedMs / 1000).toFixed(1)}s | ${b.totalTokens.input + b.totalTokens.output} |`,
		);
	}

	lines.push("");

	for (const b of benchmarks) {
		lines.push(`### ${b.skillName}`);
		for (const r of b.results) {
			const icon = r.passed ? "PASS" : "FAIL";
			lines.push(`- [${icon}] ${r.evalName}: ${r.score}/100 - ${r.feedback}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

function formatComparison(skillName: string, withSkill: EvalResult[], withoutSkill: EvalResult[]): string {
	const withPassed = withSkill.filter((r) => r.passed).length;
	const withoutPassed = withoutSkill.filter((r) => r.passed).length;
	const withAvg = withSkill.length > 0 ? Math.round(withSkill.reduce((s, r) => s + r.score, 0) / withSkill.length) : 0;
	const withoutAvg =
		withoutSkill.length > 0 ? Math.round(withoutSkill.reduce((s, r) => s + r.score, 0) / withoutSkill.length) : 0;

	const lines: string[] = [
		`## A/B Comparison: ${skillName}`,
		"",
		"| Metric | With Skill | Without Skill |",
		"|--------|-----------|---------------|",
		`| Pass Rate | ${withPassed}/${withSkill.length} | ${withoutPassed}/${withoutSkill.length} |`,
		`| Avg Score | ${withAvg}/100 | ${withoutAvg}/100 |`,
		"",
	];

	if (withoutAvg >= withAvg) {
		lines.push(
			"> The base model performs equally well or better without the skill. " +
				"The skill may no longer be necessary for this model.",
		);
	} else {
		lines.push(`> The skill improves performance by ${withAvg - withoutAvg} points on average.`);
	}

	lines.push("", "### Per-eval breakdown");

	for (let i = 0; i < withSkill.length; i++) {
		const w = withSkill[i];
		const wo = withoutSkill[i];
		const diff = w.score - wo.score;
		const arrow = diff > 0 ? "+" : diff < 0 ? "" : "=";
		lines.push(`- **${w.evalName}**: ${w.score} vs ${wo.score} (${arrow}${diff})`);
		lines.push(`  - With: ${w.feedback}`);
		lines.push(`  - Without: ${wo.feedback}`);
	}

	return lines.join("\n");
}

// ============================================================================
// Extension
// ============================================================================

export default function skillEvalExtension(pi: ExtensionAPI) {
	pi.registerCommand("skill-eval", {
		description: "Test, benchmark, and compare skills",
		getArgumentCompletions: (prefix) => {
			const subcommands = ["list", "run", "benchmark", "compare", "tune"];
			const matching = subcommands.filter((s) => s.startsWith(prefix));
			return matching.length > 0 ? matching.map((s) => ({ value: s, label: s })) : null;
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const subcommand = parts[0] || "";
			const skillArg = parts.slice(1).join(" ");

			switch (subcommand) {
				case "list":
					return handleList(ctx);
				case "run":
					return handleRun(skillArg, ctx);
				case "benchmark":
					return handleBenchmark(ctx);
				case "compare":
					return handleCompare(skillArg, ctx);
				case "tune":
					return handleTune(skillArg, ctx);
				default:
					return handleInteractive(ctx);
			}
		},
	});

	async function selectSkill(skills: SkillWithEvals[], ctx: ExtensionCommandContext): Promise<string | undefined> {
		const items = skills.map((s) => `${s.name} (${s.evals.length} eval${s.evals.length === 1 ? "" : "s"})`);
		const selected = await ctx.ui.select("Select skill", items);
		if (!selected) return undefined;
		return selected.split(" (")[0];
	}

	async function handleInteractive(ctx: ExtensionCommandContext) {
		const skills = discoverSkillsWithEvals(ctx.cwd);

		if (skills.length === 0) {
			ctx.ui.notify("No skills with evals found. Create evals.json alongside SKILL.md.", "info");
			return;
		}

		const action = await ctx.ui.select("Skill Eval", [
			"Run evals for a skill",
			"Run benchmark (all skills)",
			"Compare: with-skill vs without-skill",
			"Tune skill description",
		]);

		if (!action) return;

		if (action.startsWith("Run evals")) {
			const name = await selectSkill(skills, ctx);
			if (name) await handleRun(name, ctx);
		} else if (action.startsWith("Run benchmark")) {
			await handleBenchmark(ctx);
		} else if (action.startsWith("Compare")) {
			const name = await selectSkill(skills, ctx);
			if (name) await handleCompare(name, ctx);
		} else if (action.startsWith("Tune")) {
			const name = await selectSkill(skills, ctx);
			if (name) await handleTune(name, ctx);
		}
	}

	async function handleList(ctx: ExtensionCommandContext) {
		const skills = discoverSkillsWithEvals(ctx.cwd);

		if (skills.length === 0) {
			ctx.ui.notify("No skills with evals.json found", "info");
			return;
		}

		const items = skills.map(
			(s) => `${s.name} (${s.evals.length} eval${s.evals.length === 1 ? "" : "s"}) - ${s.skillDir}`,
		);

		await ctx.ui.select("Skills with Evals", items);
	}

	async function handleRun(skillName: string, ctx: ExtensionCommandContext) {
		if (!ctx.model) {
			ctx.ui.notify("No model selected", "error");
			return;
		}

		const skills = discoverSkillsWithEvals(ctx.cwd);
		let skill: SkillWithEvals | undefined;

		if (!skillName) {
			const name = await selectSkill(skills, ctx);
			if (!name) return;
			skill = skills.find((s) => s.name === name);
		} else {
			skill = skills.find((s) => s.name === skillName);
		}

		if (!skill) {
			ctx.ui.notify(`Skill "${skillName}" not found or has no evals`, "error");
			return;
		}

		ctx.ui.notify(`Running ${skill.evals.length} eval(s) for "${skill.name}"...`, "info");

		const results: EvalResult[] = [];
		for (const evalDef of skill.evals) {
			ctx.ui.setStatus("skill-eval", `Running: ${evalDef.name}...`);
			const result = await runSingleEval(
				evalDef,
				skill.name,
				skill.skillContent,
				ctx.model,
				ctx.modelRegistry,
				ctx.cwd,
			);
			results.push(result);
		}

		ctx.ui.setStatus("skill-eval", undefined);

		pi.sendMessage({
			customType: "skill-eval-results",
			content: formatResults(skill.name, results),
			display: true,
		});
	}

	async function handleBenchmark(ctx: ExtensionCommandContext) {
		if (!ctx.model) {
			ctx.ui.notify("No model selected", "error");
			return;
		}

		const skills = discoverSkillsWithEvals(ctx.cwd);

		if (skills.length === 0) {
			ctx.ui.notify("No skills with evals found", "info");
			return;
		}

		const totalEvalCount = skills.reduce((sum, s) => sum + s.evals.length, 0);
		ctx.ui.notify(`Running benchmark: ${totalEvalCount} eval(s) across ${skills.length} skill(s)...`, "info");

		const benchmarks: BenchmarkResult[] = [];
		let completed = 0;

		for (const skill of skills) {
			const results: EvalResult[] = [];

			for (const evalDef of skill.evals) {
				completed++;
				ctx.ui.setStatus("skill-eval", `Benchmark: ${completed}/${totalEvalCount} - ${skill.name}/${evalDef.name}`);

				const result = await runSingleEval(
					evalDef,
					skill.name,
					skill.skillContent,
					ctx.model,
					ctx.modelRegistry,
					ctx.cwd,
				);
				results.push(result);
			}

			const passed = results.filter((r) => r.passed).length;
			benchmarks.push({
				skillName: skill.name,
				totalEvals: results.length,
				passed,
				passRate: results.length > 0 ? Math.round((passed / results.length) * 100) : 0,
				totalElapsedMs: results.reduce((sum, r) => sum + r.elapsedMs, 0),
				totalTokens: {
					input: results.reduce((sum, r) => sum + r.tokens.input, 0),
					output: results.reduce((sum, r) => sum + r.tokens.output, 0),
				},
				results,
			});
		}

		ctx.ui.setStatus("skill-eval", undefined);

		pi.sendMessage({
			customType: "skill-eval-benchmark",
			content: formatBenchmark(benchmarks),
			display: true,
		});
	}

	async function handleCompare(skillName: string, ctx: ExtensionCommandContext) {
		if (!ctx.model) {
			ctx.ui.notify("No model selected", "error");
			return;
		}

		const skills = discoverSkillsWithEvals(ctx.cwd);
		let skill: SkillWithEvals | undefined;

		if (!skillName) {
			const name = await selectSkill(skills, ctx);
			if (!name) return;
			skill = skills.find((s) => s.name === name);
		} else {
			skill = skills.find((s) => s.name === skillName);
		}

		if (!skill) {
			ctx.ui.notify(`Skill "${skillName}" not found or has no evals`, "error");
			return;
		}

		const evalCount = skill.evals.length;
		ctx.ui.notify(`Comparing "${skill.name}": with vs without skill (${evalCount * 2} runs)...`, "info");

		const withSkillResults: EvalResult[] = [];
		const withoutSkillResults: EvalResult[] = [];

		for (let i = 0; i < evalCount; i++) {
			const evalDef = skill.evals[i];

			ctx.ui.setStatus("skill-eval", `Compare ${i + 1}/${evalCount}: ${evalDef.name} (with skill)`);
			const withResult = await runSingleEval(
				evalDef,
				skill.name,
				skill.skillContent,
				ctx.model,
				ctx.modelRegistry,
				ctx.cwd,
			);
			withSkillResults.push(withResult);

			ctx.ui.setStatus("skill-eval", `Compare ${i + 1}/${evalCount}: ${evalDef.name} (without skill)`);
			const withoutResult = await runSingleEval(
				evalDef,
				skill.name,
				undefined,
				ctx.model,
				ctx.modelRegistry,
				ctx.cwd,
			);
			withoutSkillResults.push(withoutResult);
		}

		ctx.ui.setStatus("skill-eval", undefined);

		pi.sendMessage({
			customType: "skill-eval-compare",
			content: formatComparison(skill.name, withSkillResults, withoutSkillResults),
			display: true,
		});
	}

	async function handleTune(skillName: string, ctx: ExtensionCommandContext) {
		if (!ctx.model) {
			ctx.ui.notify("No model selected", "error");
			return;
		}

		const skills = discoverSkillsWithEvals(ctx.cwd);
		let skill: SkillWithEvals | undefined;

		if (!skillName) {
			const name = await selectSkill(skills, ctx);
			if (!name) return;
			skill = skills.find((s) => s.name === name);
		} else {
			skill = skills.find((s) => s.name === skillName);
		}

		if (!skill) {
			ctx.ui.notify(`Skill "${skillName}" not found`, "error");
			return;
		}

		ctx.ui.notify("Analyzing skill description...", "info");
		ctx.ui.setStatus("skill-eval", "Tuning description...");

		const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
		if (!apiKey) {
			ctx.ui.setStatus("skill-eval", undefined);
			ctx.ui.notify("No API key available", "error");
			return;
		}

		const evalPrompts = skill.evals.map((e) => `- "${e.prompt}"`).join("\n");

		const tunePrompt = [
			"Analyze this skill's description for triggering accuracy.",
			"",
			"## Current Skill File",
			skill.skillContent,
			"",
			"## Sample prompts that SHOULD trigger this skill:",
			evalPrompts,
			"",
			"## Task",
			"1. Evaluate if the current description would reliably trigger for sample prompts",
			"2. Identify false positives (prompts that might wrongly trigger this skill)",
			"3. Identify false negatives (sample prompts that might not trigger this skill)",
			"4. Suggest an improved description that matches more precisely",
			"",
			"Provide structured analysis with sections:",
			"- Current Description Analysis",
			"- False Positive Risks",
			"- False Negative Risks",
			"- Suggested Improved Description",
		].join("\n");

		try {
			const result: AssistantMessage = await complete(
				ctx.model,
				{
					messages: [
						{
							role: "user" as const,
							content: [{ type: "text" as const, text: tunePrompt }],
							timestamp: Date.now(),
						},
					],
				},
				{ apiKey },
			);

			const analysis = result.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");

			ctx.ui.setStatus("skill-eval", undefined);

			pi.sendMessage({
				customType: "skill-eval-tune",
				content: `## Description Analysis: ${skill.name}\n\n${analysis}`,
				display: true,
			});
		} catch (error) {
			ctx.ui.setStatus("skill-eval", undefined);
			ctx.ui.notify(`Tune failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}
}
