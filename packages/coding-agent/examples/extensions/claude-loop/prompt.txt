
/loop — Detailed Implementation in versions/2.1.71/cli.js

Overview

/loop is a slash command (skill) that schedules a prompt to run on a recurring
  interval. It is syntactic sugar over the internal Kairos Cron scheduling
system (CronCreate / CronDelete / CronList tools).

---
1. Skill Registration (cli.js:561008–561023)

The registerLoopSkill() function (qgz) calls the generic skill registrar WH():

WH({
  name: "loop",
  description: "Run a prompt or slash command on a recurring interval (e.g. 
/loop 5m /foo, defaults to 10m)",
  whenToUse: 'When the user wants to set up a recurring task, poll for status,
  or run something repeatedly on an interval',
  argumentHint: "[interval] <prompt>",
  userInvocable: true,
  isEnabled: lC,           // gated by feature flag "tengu_kairos_cron"
  getPromptForCommand(A) { // A = raw user input after "/loop"
    if (!A.trim()) return [{ type: "text", text: usageText }];
    return [{ type: "text", text: Agz(A.trim()) }];
  },
});

- Feature gate: lC() checks the flag tengu_kairos_cron (polled every 5 min /
300s). If disabled, /loop is hidden.
- Default interval: Ze6 = "10m".

2. The Prompt Template (cli.js:560960–561006)

When the user types e.g. /loop 5m check deploys, the function Agz(input)
generates a structured LLM prompt that instructs Claude to:

1. Parse the input into [interval] <prompt> using three priority rules:
  - Rule 1 — Leading token: If the first token matches ^\d+[smhd]$ (e.g. 5m,
2h), that's the interval; the rest is the prompt.
  - Rule 2 — Trailing "every" clause: If the input ends with every <N><unit>
(e.g. every 20m, every 5 minutes), extract that as interval. Does NOT match
check every PR (no time expression).
  - Rule 3 — Default: Interval = 10m, entire input = prompt.
2. Convert interval to a cron expression using a mapping table:
| Pattern   | Cron        | Notes                |
|-----------|-------------|----------------------|
| Nm (N≤59) | */N * * * * | every N minutes      |
| Nm (N≥60) | 0 */H * * * | round to hours       |
| Nh (N≤23) | 0 */N * * * | every N hours        |
| Nd        | 0 0 */N * * | every N days         |
| Ns        | ceil(N/60)m | rounds up to minutes |

3. Call CronCreate with { cron, prompt, recurring: true }.
4. Confirm to the user: what's scheduled, the cron expression, human-readable
cadence, 3-day auto-expiry, and how to cancel with CronDelete.

3. CronCreate Tool (cli.js:450031–450148)

The actual scheduling tool. Key aspects:

- Input schema: { cron: string, prompt: string, recurring?: bool, durable?: 
bool }
- Validation (validateInput):
  - Cron expression must be valid 5-field format (parsed by _a6)
  - Must match at least one future date within a year (wk6)
  - Max 50 concurrent jobs
- call() method (cli.js:450124–450130):
async call({ cron, prompt, recurring = true, durable = false }) {
  let id = await UOq(cron, prompt, recurring, durable);
  XR6(true);  // enables scheduler
  return { data: { id, humanSchedule: zk6(cron), recurring, durable } };
}
- Storage (UOq, cli.js:449805–449816):
  - Generates a UUID-based 8-char job ID
  - Non-durable (default): pushes to in-memory sessionCronTasks array via
_F1()
  - Durable: reads .claude/scheduled_tasks.json, appends, writes back

4. Cron Scheduler (createCronScheduler, cli.js:572588–572769)

This is the runtime engine that fires jobs:

- Tick interval: MQq = 1000 (checks every 1 second)
- Startup (start()):
  - If scheduledTasksEnabled is already true, starts immediately
  - Otherwise, polls every 1s until the flag is set (set by CronCreate)
  - Uses chokidar to watch .claude/scheduled_tasks.json for changes (durable
tasks)
  - Uses a file lock system for multi-session safety
- Tick function (v(), cli.js:572635–572693):
  - Skips if the REPL is currently loading/busy (isLoading()) — jobs only fire
  when idle
  - For each registered job:
      i. Computes next fire time using _l8 (recurring) or dOq (one-shot)
    ii. If Date.now() >= fireTime, fires the job by calling onFire(prompt)
    iii. Recurring + not aged: reschedules (computes next fire time)
    iv. Recurring + aged (>3 days): fires one final time, then deletes
    v. One-shot: deletes after firing
- Jitter (_l8, cli.js:449843–449850):
  - Recurring: adds up to 10% of the period (capped at 15 min / recurringCapMs
  = 900000)
  - One-shot (dOq): if landing on :00 or :30, shifts up to 90s earlier
  - Jitter is deterministic per job ID (hashes first 8 hex chars of the UUID)
- Auto-expiry (XQq, cli.js:572585):
  - DQq = 259200000 ms = 3 days
  - Recurring (non-permanent) tasks are deleted after 3 days from creation
- Missed task detection (cli.js:572611–572633):
  - On startup, checks for one-shot tasks whose fire time has passed
  - Surfaces a notification asking the user whether to run them

5. Human-Readable Schedule (zk6, cli.js:449672–449712)

Converts cron expressions to readable strings like:
- */5 * * * * → "Every 5 minutes"
- 0 */2 * * * → "Every 2 hours"
- 0 9 * * 1-5 → "Weekdays at 9:00 AM"

6. Supporting Tools

- CronDelete (cli.js:450150–450226): Cancels a job by ID. Removes from
in-memory store or .claude/scheduled_tasks.json.
- CronList (cli.js:450228+): Lists all active jobs (both in-memory and
durable).

Architecture Summary

User types: /loop 5m /babysit-prs
  │
  ▼
registerLoopSkill.getPromptForCommand()
  │  generates structured LLM prompt with parsing rules
  ▼
LLM parses "5m /babysit-prs" → interval=5m, prompt="/babysit-prs"
  │  converts 5m → cron "*/5 * * * *"
  ▼
LLM calls CronCreate tool
  │  { cron: "*/5 * * * *", prompt: "/babysit-prs", recurring: true }
  ▼
CronCreate.call()
  │  stores job in memory (or .claude/scheduled_tasks.json if durable)
  │  sets scheduledTasksEnabled = true
  ▼
CronScheduler tick (every 1s)
  │  checks if current time ≥ next fire time (with jitter)
  │  waits for REPL idle
  ▼
onFire("/babysit-prs")  →  enqueues prompt into REPL
  │  reschedules next fire (recurring) or deletes (one-shot)
  │  auto-expires after 3 days