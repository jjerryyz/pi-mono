import { describe, expect, it } from "vitest";
import { buildLoopSlashCommand, parseLoopCommandInput } from "../examples/extensions/loop/command.js";
import { formatIntervalMs, parseIntervalSpec } from "../examples/extensions/loop/scheduler.js";

describe("loop command parsing", () => {
	it("parses a leading interval as a schedule command", () => {
		expect(parseLoopCommandInput("5m check deploys")).toEqual({
			action: "schedule",
			intervalText: "5m",
			intervalMs: 5 * 60 * 1000,
			prompt: "check deploys",
		});
	});

	it("parses a trailing every clause as a schedule command", () => {
		expect(parseLoopCommandInput("check deploys every 20m")).toEqual({
			action: "schedule",
			intervalText: "20m",
			intervalMs: 20 * 60 * 1000,
			prompt: "check deploys",
		});
	});

	it("defaults to 10 minutes when no interval is provided", () => {
		expect(parseLoopCommandInput("check deploy status")).toEqual({
			action: "schedule",
			intervalText: "10m",
			intervalMs: 10 * 60 * 1000,
			prompt: "check deploy status",
		});
	});

	it("does not treat plain english every text as an interval", () => {
		expect(parseLoopCommandInput("check every PR")).toEqual({
			action: "schedule",
			intervalText: "10m",
			intervalMs: 10 * 60 * 1000,
			prompt: "check every PR",
		});
	});

	it("parses list and cancel subcommands", () => {
		expect(parseLoopCommandInput("list")).toEqual({ action: "list" });
		expect(parseLoopCommandInput("cancel job-7")).toEqual({ action: "cancel", jobId: "job-7" });
	});
});

describe("loop cli command builder", () => {
	it("builds slash commands for explicit cli subcommands", () => {
		expect(buildLoopSlashCommand(["schedule", "5m", "check deploys"])).toBe("/loop 5m check deploys");
		expect(buildLoopSlashCommand(["list"])).toBe("/loop list");
		expect(buildLoopSlashCommand(["cancel", "job-7"])).toBe("/loop cancel job-7");
	});

	it("supports raw pass-through scheduling args", () => {
		expect(buildLoopSlashCommand(["5m", "check deploys"])).toBe("/loop 5m check deploys");
	});

	it("rejects missing cli arguments", () => {
		expect(() => buildLoopSlashCommand([])).toThrow("Usage:");
		expect(() => buildLoopSlashCommand(["cancel"])).toThrow("Usage:");
	});
});

describe("loop scheduler interval helpers", () => {
	it("parses interval specs across supported units", () => {
		expect(parseIntervalSpec("45s")).toBe(45_000);
		expect(parseIntervalSpec("2h")).toBe(2 * 60 * 60 * 1000);
		expect(parseIntervalSpec("3d")).toBe(3 * 24 * 60 * 60 * 1000);
	});

	it("formats intervals for human-readable status", () => {
		expect(formatIntervalMs(45_000)).toBe("every 45s");
		expect(formatIntervalMs(5 * 60 * 1000)).toBe("every 5m");
		expect(formatIntervalMs(2 * 60 * 60 * 1000)).toBe("every 2h");
	});
});
