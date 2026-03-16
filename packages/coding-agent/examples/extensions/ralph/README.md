# Ralph Extension

Autonomous PRD-driven agent loop for pi. Implements the [Ralph pattern](https://ghuntley.com/ralph/) — repeatedly drives the agent to implement user stories from a PRD, one per iteration, until all stories pass or max iterations are reached.

## How It Works

1. You provide a `prd.json` with user stories (tasks, acceptance criteria, priorities)
2. Ralph injects workflow instructions into the system prompt
3. Each iteration: the agent picks the highest-priority incomplete story, implements it, runs checks, commits, and marks it done
4. After each iteration, Ralph auto-sends a follow-up message to start the next story
5. Memory persists across iterations via `progress.txt`, git history, and pi's session context

## Usage

```bash
pi --extension examples/extensions/ralph/index.ts
```

Then inside pi:

```
/ralph start                    # Uses ./prd.json, max 10 iterations
/ralph start path/to/prd.json   # Custom PRD path
/ralph start prd.json 20        # Custom max iterations
/ralph status                   # Show PRD completion status
/ralph stop                     # Stop the auto-loop
```

## PRD Format

Create a `prd.json` in your project:

```json
{
  "project": "MyApp",
  "branchName": "ralph/feature-name",
  "description": "Feature description",
  "userStories": [
    {
      "id": "US-001",
      "title": "Add priority field to database",
      "description": "As a developer, I need to store task priority.",
      "acceptanceCriteria": [
        "Add priority column to tasks table",
        "Migration runs successfully",
        "Typecheck passes"
      ],
      "priority": 1,
      "passes": false,
      "notes": ""
    }
  ]
}
```

Stories are ordered by `priority` (lowest number = highest priority). Each story should be small enough to fit in one agent iteration.

## Tools

The extension registers three tools for the LLM:

| Tool | Description |
|------|-------------|
| `ralph_mark_story` | Mark a story as passed/failed in prd.json |
| `ralph_status` | Check completion status of all stories |
| `ralph_append_progress` | Append a progress entry to progress.txt |

## Skills

The extension bundles a `ralph-prd` skill that guides the agent through creating a well-structured `prd.json`. Use it via:

```
/skill:ralph-prd
```

Or just ask "create a PRD for [feature]" and the agent will load it automatically.

The skill walks through:
1. Asking clarifying questions about the feature
2. Generating properly sized and ordered user stories
3. Writing `prd.json` with verifiable acceptance criteria

## Commands

| Command | Description |
|---------|-------------|
| `/ralph start [path] [max]` | Start the Ralph loop |
| `/ralph stop` | Stop the auto-loop |
| `/ralph status` | Show PRD completion status |
| `/skill:ralph-prd` | Generate a prd.json for a feature |

## Files

| File | Purpose |
|------|---------|
| `prd.json` | Task list with user stories and completion status |
| `progress.txt` | Append-only log of learnings and patterns across iterations |

## Differences from ralph.sh

The original Ralph spawns a fresh process per iteration (no in-memory state). This pi extension keeps a continuous session with compaction, which means:

- Context from earlier iterations is preserved (compacted, not lost)
- No cold-start overhead per iteration
- The system prompt is updated each iteration with current PRD state
- Tools provide structured PRD management (no manual JSON editing)
