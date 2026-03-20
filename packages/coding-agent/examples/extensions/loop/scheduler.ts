export const DEFAULT_LOOP_INTERVAL = "10m";

const INTERVAL_UNIT_MS = {
	s: 1000,
	m: 60 * 1000,
	h: 60 * 60 * 1000,
	d: 24 * 60 * 60 * 1000,
} as const;

type IntervalUnit = keyof typeof INTERVAL_UNIT_MS;

export interface LoopJob {
	id: string;
	prompt: string;
	intervalText: string;
	intervalMs: number;
	createdAt: number;
	nextRunAt: number;
	runCount: number;
}

export function normalizeIntervalSpec(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;

	const compactMatch = trimmed.match(/^(\d+)([smhd])$/i);
	if (compactMatch) {
		return `${compactMatch[1]}${compactMatch[2].toLowerCase()}`;
	}

	const longMatch = trimmed.match(/^(\d+)\s*(seconds?|minutes?|hours?|days?)$/i);
	if (!longMatch) return null;

	const unitLabel = longMatch[2].toLowerCase();
	const unit: IntervalUnit = unitLabel.startsWith("second")
		? "s"
		: unitLabel.startsWith("minute")
			? "m"
			: unitLabel.startsWith("hour")
				? "h"
				: "d";

	return `${longMatch[1]}${unit}`;
}

export function parseIntervalSpec(input: string): number {
	const normalized = normalizeIntervalSpec(input);
	if (!normalized) {
		throw new Error(`Invalid interval: ${input}`);
	}

	const match = normalized.match(/^(\d+)([smhd])$/);
	if (!match) {
		throw new Error(`Invalid interval: ${input}`);
	}

	const value = Number.parseInt(match[1], 10);
	const unit = match[2] as IntervalUnit;
	return value * INTERVAL_UNIT_MS[unit];
}

export function formatIntervalMs(intervalMs: number): string {
	if (intervalMs % INTERVAL_UNIT_MS.d === 0) return `every ${intervalMs / INTERVAL_UNIT_MS.d}d`;
	if (intervalMs % INTERVAL_UNIT_MS.h === 0) return `every ${intervalMs / INTERVAL_UNIT_MS.h}h`;
	if (intervalMs % INTERVAL_UNIT_MS.m === 0) return `every ${intervalMs / INTERVAL_UNIT_MS.m}m`;
	return `every ${Math.max(1, Math.round(intervalMs / INTERVAL_UNIT_MS.s))}s`;
}

function formatRemainingMs(remainingMs: number): string {
	if (remainingMs <= 0) return "due now";
	if (remainingMs % INTERVAL_UNIT_MS.d === 0) return `in ${remainingMs / INTERVAL_UNIT_MS.d}d`;
	if (remainingMs % INTERVAL_UNIT_MS.h === 0) return `in ${remainingMs / INTERVAL_UNIT_MS.h}h`;
	if (remainingMs % INTERVAL_UNIT_MS.m === 0) return `in ${remainingMs / INTERVAL_UNIT_MS.m}m`;
	return `in ${Math.max(1, Math.ceil(remainingMs / INTERVAL_UNIT_MS.s))}s`;
}

export function formatLoopJobs(jobs: LoopJob[], now = Date.now()): string {
	if (jobs.length === 0) return "No loop jobs scheduled.";

	return jobs
		.map((job) => {
			const nextRun = formatRemainingMs(job.nextRunAt - now);
			return `${job.id}  ${formatIntervalMs(job.intervalMs)}  ${nextRun}  ${job.prompt}`;
		})
		.join("\n");
}

export class LoopScheduler {
	private readonly jobs = new Map<string, LoopJob>();
	private nextId = 1;
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private readonly onFire: (job: LoopJob) => void,
		private readonly now: () => number = () => Date.now(),
		private readonly tickIntervalMs = 1000,
	) {}

	schedule(intervalText: string, prompt: string): LoopJob {
		const normalizedInterval = normalizeIntervalSpec(intervalText);
		if (!normalizedInterval) {
			throw new Error(`Invalid interval: ${intervalText}`);
		}

		const intervalMs = parseIntervalSpec(normalizedInterval);
		const createdAt = this.now();
		const job: LoopJob = {
			id: `job-${this.nextId++}`,
			prompt,
			intervalText: normalizedInterval,
			intervalMs,
			createdAt,
			nextRunAt: createdAt + intervalMs,
			runCount: 0,
		};

		this.jobs.set(job.id, job);
		this.start();
		return { ...job };
	}

	cancel(jobId: string): boolean {
		return this.jobs.delete(jobId);
	}

	list(): LoopJob[] {
		return [...this.jobs.values()].sort((a, b) => a.nextRunAt - b.nextRunAt).map((job) => ({ ...job }));
	}

	dispose(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	private start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			this.tick();
		}, this.tickIntervalMs);
		this.timer.unref?.();
	}

	private tick(): void {
		const now = this.now();
		for (const job of this.jobs.values()) {
			if (job.nextRunAt > now) continue;

			job.runCount += 1;
			job.nextRunAt = now + job.intervalMs;

			try {
				this.onFire({ ...job });
			} catch {
				// Keep the example scheduler simple: failed callbacks do not stop the loop.
			}
		}
	}
}
