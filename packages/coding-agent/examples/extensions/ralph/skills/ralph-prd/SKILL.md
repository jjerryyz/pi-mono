---
name: ralph-prd
description: Generate a prd.json file for the Ralph autonomous agent loop. Use when planning a feature for Ralph, creating a PRD, or when asked to set up a Ralph task list. Triggers on phrases like "create a prd", "plan this feature for ralph", "set up ralph tasks", "generate prd.json".
---

# Ralph PRD Generator

Generate a `prd.json` that the Ralph extension uses to drive autonomous implementation.

## Workflow

1. Receive a feature description from the user
2. Ask 3-5 clarifying questions (with lettered options for quick answers)
3. Generate `prd.json` with properly sized and ordered user stories
4. Save to the project root (or user-specified path)

**Do NOT start implementing. Only create the PRD.**

## Step 1: Clarifying Questions

Ask only critical questions where the initial description is ambiguous:

- **Problem/Goal:** What problem does this solve?
- **Core Functionality:** What are the key user actions?
- **Scope/Boundaries:** What should it NOT do?
- **Tech Stack:** What frameworks/tools does the project use?
- **Quality Checks:** What checks should pass? (typecheck, lint, test, etc.)

Format with lettered options so users can respond with "1A, 2C, 3B":

```
1. What is the primary goal?
   A. Improve user experience
   B. Add new capability
   C. Fix existing limitation
   D. Other: [please specify]

2. What is the scope?
   A. Minimal viable version
   B. Full-featured implementation
   C. Backend only
   D. Frontend only
```

## Step 2: Generate prd.json

### Format

```json
{
  "project": "ProjectName",
  "branchName": "ralph/feature-name-kebab-case",
  "description": "Brief feature description",
  "userStories": [
    {
      "id": "US-001",
      "title": "Short descriptive title",
      "description": "As a [user], I want [feature] so that [benefit].",
      "acceptanceCriteria": [
        "Specific verifiable criterion",
        "Another criterion",
        "Typecheck passes"
      ],
      "priority": 1,
      "passes": false,
      "notes": ""
    }
  ]
}
```

### Story Sizing (Critical)

Each story must be completable in ONE agent iteration (one context window).

Right-sized:
- Add a database column and migration
- Create a single UI component
- Add one API endpoint
- Add a filter/sort to an existing list

Too big (split these):
- "Build the entire dashboard" -> schema, queries, UI components, filters
- "Add authentication" -> schema, middleware, login UI, session handling
- "Refactor the API" -> one story per endpoint or pattern

**Rule of thumb:** If you cannot describe the change in 2-3 sentences, split it.

### Story Ordering

Stories execute in priority order. Earlier stories must not depend on later ones.

Correct order:
1. Schema / database changes (migrations)
2. Backend logic / server actions
3. UI components that use the backend
4. Dashboard / summary views that aggregate

### Acceptance Criteria

Each criterion must be verifiable, not vague.

Good:
- "Add `status` column to tasks table with default 'pending'"
- "Filter dropdown has options: All, Active, Completed"
- "Clicking delete shows confirmation dialog"

Bad:
- "Works correctly"
- "Good UX"
- "Handles edge cases"

Always include as final criterion: `"Typecheck passes"`

For stories with testable logic, also include: `"Tests pass"`

For stories that change UI, also include: `"Verify UI changes in browser"`

### Fields

| Field | Rule |
|-------|------|
| `project` | Project name from package.json or user input |
| `branchName` | `ralph/` prefix + kebab-case feature name |
| `id` | Sequential: US-001, US-002, ... |
| `priority` | 1 = highest priority, based on dependency order |
| `passes` | Always `false` for new stories |
| `notes` | Always empty string for new stories |

## Checklist Before Saving

- [ ] Asked clarifying questions and incorporated answers
- [ ] Each story is completable in one iteration
- [ ] Stories are ordered by dependency (schema -> backend -> UI)
- [ ] Every story has "Typecheck passes" as criterion
- [ ] UI stories have browser verification criterion
- [ ] Acceptance criteria are specific and verifiable
- [ ] No story depends on a later story
- [ ] `branchName` uses `ralph/` prefix with kebab-case

## Example

**User says:** "Add a task priority system with high/medium/low levels"

**Generated prd.json:**
```json
{
  "project": "MyApp",
  "branchName": "ralph/task-priority",
  "description": "Task Priority System - Add priority levels to tasks",
  "userStories": [
    {
      "id": "US-001",
      "title": "Add priority field to database",
      "description": "As a developer, I need to store task priority so it persists across sessions.",
      "acceptanceCriteria": [
        "Add priority column to tasks table: 'high' | 'medium' | 'low' (default 'medium')",
        "Generate and run migration successfully",
        "Typecheck passes"
      ],
      "priority": 1,
      "passes": false,
      "notes": ""
    },
    {
      "id": "US-002",
      "title": "Display priority indicator on task cards",
      "description": "As a user, I want to see task priority at a glance.",
      "acceptanceCriteria": [
        "Each task card shows colored priority badge (red=high, yellow=medium, gray=low)",
        "Priority visible without hovering or clicking",
        "Typecheck passes",
        "Verify UI changes in browser"
      ],
      "priority": 2,
      "passes": false,
      "notes": ""
    },
    {
      "id": "US-003",
      "title": "Add priority selector to task edit",
      "description": "As a user, I want to change a task's priority when editing it.",
      "acceptanceCriteria": [
        "Priority dropdown in task edit modal",
        "Shows current priority as selected",
        "Saves immediately on selection change",
        "Typecheck passes",
        "Verify UI changes in browser"
      ],
      "priority": 3,
      "passes": false,
      "notes": ""
    },
    {
      "id": "US-004",
      "title": "Filter tasks by priority",
      "description": "As a user, I want to filter the task list to see only high-priority items.",
      "acceptanceCriteria": [
        "Filter dropdown with options: All | High | Medium | Low",
        "Filter persists in URL params",
        "Empty state message when no tasks match filter",
        "Typecheck passes",
        "Verify UI changes in browser"
      ],
      "priority": 4,
      "passes": false,
      "notes": ""
    }
  ]
}
```

After creating prd.json, tell the user to start the Ralph loop with `/ralph start`.
