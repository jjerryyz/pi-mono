# Loop Extension Example

Example recurring-task extension plus a companion CLI that keeps a local loop runtime alive.

## Prerequisites

Build `pi` first so `dist/cli.js` exists:

```bash
npm run build
```

Set up your model the same way you would for normal `pi` usage:

```bash
export ANTHROPIC_API_KEY=...
# or configure a default model/provider in pi
```

## Interactive Extension Usage

Load the extension directly:

```bash
pi --extension examples/extensions/loop/index.ts
```

Then use the slash command:

```bash
/loop 5m check deploys
/loop check deploys every 20m
/loop list
/loop cancel job-1
```

Rules:

- Leading interval wins: `/loop 5m check deploys`
- Trailing `every` clause also works: `/loop check deploys every 20m`
- No interval defaults to `10m`

## Companion CLI Usage

Start the standalone loop host:

```bash
npx tsx examples/extensions/loop/cli.ts schedule 5m "check deploys"
```

Shorthand raw form:

```bash
npx tsx examples/extensions/loop/cli.ts 5m "check deploys"
```

After scheduling, the CLI stays alive and hosts the in-memory loop runtime. In a TTY, you can then type:

```text
list
cancel job-1
15m check staging deploys
exit
```

## Notes

- Jobs are in-memory only. They disappear when the interactive pi session or the CLI process exits.
- The companion CLI is the process that hosts those jobs. `list` and `cancel` are therefore most useful from the CLI's interactive prompt after scheduling.
- This is an example extension, not a core `pi loop` subcommand.
- The companion CLI uses `pi --mode rpc` internally and explicitly loads `examples/extensions/loop/index.ts`.
