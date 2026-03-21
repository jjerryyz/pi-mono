import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { LOOP_COMMAND_USAGE, parseLoopCommandInput } from "./command.js";
import { formatIntervalMs, formatLoopJobs, type LoopJob, LoopScheduler } from "./scheduler.js";

function buildLoopPrompt(job: LoopJob): string {
	return [
		`[loop ${job.id}] Scheduled task fired (${formatIntervalMs(job.intervalMs)}).`,
		"Run the original request below and respond normally.",
		"",
		job.prompt,
	].join("\n");
}

function commandCompletions(prefix: string): AutocompleteItem[] | null {
	const commands = ["list", "cancel", "help"];
	const items = commands.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
	return items.length > 0 ? items : null;
}

export default function loopExtension(pi: ExtensionAPI) {
	let agentBusy = false;
	const scheduler = new LoopScheduler((job) => {
		const prompt = buildLoopPrompt(job);
		if (agentBusy) {
			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			return;
		}
		pi.sendUserMessage(prompt);
	});

	pi.on("agent_start", async () => {
		agentBusy = true;
	});

	pi.on("agent_end", async () => {
		agentBusy = false;
	});

	pi.on("session_shutdown", async () => {
		scheduler.dispose();
	});

	pi.registerCommand("loop", {
		description: "Run a prompt on a recurring interval: /loop 5m check deploys",
		getArgumentCompletions: commandCompletions,
		handler: async (args, ctx) => {
			const command = parseLoopCommandInput(args);

			switch (command.action) {
				case "help":
					ctx.ui.notify(LOOP_COMMAND_USAGE, "info");
					return;

				case "list":
					ctx.ui.notify(formatLoopJobs(scheduler.list()), "info");
					return;

				case "cancel": {
					const didCancel = scheduler.cancel(command.jobId);
					ctx.ui.notify(
						didCancel ? `Cancelled loop job ${command.jobId}.` : `Loop job not found: ${command.jobId}`,
						didCancel ? "info" : "warning",
					);
					return;
				}

				case "schedule": {
					const job = scheduler.schedule(command.intervalText, command.prompt);
					ctx.ui.notify(
						`Scheduled ${job.id}: ${formatIntervalMs(job.intervalMs)} -> ${job.prompt}\nUse /loop list or /loop cancel ${job.id}.`,
						"info",
					);
					return;
				}
			}
		},
	});
}
