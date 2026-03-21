import { DEFAULT_LOOP_INTERVAL, normalizeIntervalSpec, parseIntervalSpec } from "./scheduler.js";

export const LOOP_COMMAND_USAGE = [
	"Usage:",
	"  /loop <prompt>",
	"  /loop <interval> <prompt>",
	"  /loop <prompt> every <interval>",
	"  /loop list",
	"  /loop cancel <job-id>",
].join("\n");

export const LOOP_CLI_USAGE = [
	"Usage:",
	"  npx tsx examples/extensions/loop/cli.ts schedule [interval] <prompt>",
	"  npx tsx examples/extensions/loop/cli.ts list",
	"  npx tsx examples/extensions/loop/cli.ts cancel <job-id>",
	"  npx tsx examples/extensions/loop/cli.ts [interval] <prompt>",
].join("\n");

export type LoopCommandInput =
	| {
			action: "schedule";
			intervalText: string;
			intervalMs: number;
			prompt: string;
	  }
	| { action: "list" }
	| { action: "cancel"; jobId: string }
	| { action: "help" };

const COMPACT_INTERVAL_RE = /^(\d+)([smhd])$/i;
const EVERY_CLAUSE_RE = /^(.+?)\s+every\s+(.+)$/i;

function parseScheduleInput(input: string): Extract<LoopCommandInput, { action: "schedule" }> {
	const trimmed = input.trim();
	const tokens = trimmed.split(/\s+/).filter(Boolean);
	if (tokens.length === 0) {
		return {
			action: "schedule",
			intervalText: DEFAULT_LOOP_INTERVAL,
			intervalMs: parseIntervalSpec(DEFAULT_LOOP_INTERVAL),
			prompt: "",
		};
	}

	const leadingInterval = normalizeIntervalSpec(tokens[0]);
	if (leadingInterval) {
		const prompt = tokens.slice(1).join(" ").trim();
		return {
			action: "schedule",
			intervalText: leadingInterval,
			intervalMs: parseIntervalSpec(leadingInterval),
			prompt,
		};
	}

	const trailingMatch = trimmed.match(EVERY_CLAUSE_RE);
	if (trailingMatch) {
		const prompt = trailingMatch[1].trim();
		const intervalText = normalizeIntervalSpec(trailingMatch[2]);
		if (prompt && intervalText) {
			return {
				action: "schedule",
				intervalText,
				intervalMs: parseIntervalSpec(intervalText),
				prompt,
			};
		}
	}

	return {
		action: "schedule",
		intervalText: DEFAULT_LOOP_INTERVAL,
		intervalMs: parseIntervalSpec(DEFAULT_LOOP_INTERVAL),
		prompt: trimmed,
	};
}

export function parseLoopCommandInput(input: string): LoopCommandInput {
	const trimmed = input.trim();
	if (!trimmed || trimmed === "help") return { action: "help" };
	if (trimmed === "list") return { action: "list" };

	const cancelMatch = trimmed.match(/^cancel\s+(\S+)$/);
	if (cancelMatch) {
		return { action: "cancel", jobId: cancelMatch[1] };
	}

	const schedule = parseScheduleInput(trimmed);
	if (!schedule.prompt) return { action: "help" };
	return schedule;
}

function isExplicitCliSubcommand(value: string): boolean {
	return value === "schedule" || value === "list" || value === "cancel";
}

export function buildLoopSlashCommand(args: string[]): string {
	const trimmedArgs = args.map((arg) => arg.trim()).filter(Boolean);
	if (trimmedArgs.length === 0) {
		throw new Error(LOOP_CLI_USAGE);
	}

	const [first, ...rest] = trimmedArgs;
	if (first === "list" && rest.length === 0) return "/loop list";
	if (first === "cancel" && rest.length === 1) return `/loop cancel ${rest[0]}`;

	if (first === "schedule") {
		const payload = rest.join(" ").trim();
		if (!payload) throw new Error(LOOP_CLI_USAGE);
		return `/loop ${payload}`;
	}

	if (isExplicitCliSubcommand(first)) {
		throw new Error(LOOP_CLI_USAGE);
	}

	if (COMPACT_INTERVAL_RE.test(first) || rest.length > 0) {
		return `/loop ${trimmedArgs.join(" ")}`;
	}

	throw new Error(LOOP_CLI_USAGE);
}
