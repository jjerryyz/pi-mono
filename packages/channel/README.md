# pi-channel

`pi-channel` is a standalone channel bridge for `pi`. It takes inbound messages from external systems, routes them into per-channel `pi` RPC sessions, and exposes replies back over HTTP polling or Socket.IO.

The design is inspired by Claude Code Channels and `packages/mom/`:

- inbound messages are wrapped as `<channel ...>...</channel>`
- each `channelId` gets its own persistent `pi` session
- replies go back through an explicit `channel_reply` tool
- sender/source gating happens before a message reaches the agent

## Features

- HTTP webhook endpoint for inbound channel events
- Socket.IO endpoint for inbound events and live reply streaming
- one persistent `pi` RPC process per `channelId`
- built-in extension that adds `channel_reply`
- JSONL persistence for inbound events and replies under `.pi-channel/`

## Installation

```bash
npm install @mariozechner/pi-channel
```

## Usage

Run the bridge from the repo or project root you want `pi` to work in:

```bash
pi-channel --port 8788 .
```

For local monorepo development from `packages/channel`, build `packages/channel` and `packages/coding-agent`, then run:

```bash
npm run start:local
```

By default this creates a `.pi-channel/` directory in the target working directory:

```text
.pi-channel/
  channels/
    ops/
      inbound.jsonl
      replies.jsonl
  sessions/
    ops/
      ...
```

## Examples

- `examples/slack-socket-mode.ts` shows a concrete Slack Socket Mode adapter modeled after `packages/mom/`
- `examples/wechat-setup.ts` performs WeChat QR login and saves credentials for the adapter
- `examples/wechat-ilink.ts` runs a WeChat ClawBot / ilink adapter compatible with the `claude-code-wechat-channel` reference project
- `examples/README.md` explains the required environment, credentials, and how to run both adapters

## CLI

```bash
pi-channel [options] [working-directory]
```

Options:

- `--host <host>`: listen host, default `127.0.0.1`
- `--port <port>`: listen port, default `8788`
- `--data-dir <dir>`: storage directory, default `<working-directory>/.pi-channel`
- `--provider <name>`: optional `pi` provider override
- `--model <id>`: optional `pi` model override
- `--pi-cli <path>`: explicit path to `pi` CLI entrypoint
- `--allow-sources <csv>`: allowlist of inbound `source` values
- `--allow-senders <csv>`: allowlist of sender IDs from `meta.sender_id`, `meta.user_id`, or `meta.from_id`
- `--help`: show usage

## HTTP API

### `GET /health`

Returns bridge health and channel runtime state.

### `POST /channel/event`

Accepts an inbound message:

```json
{
	"channelId": "ops",
	"source": "webhook",
	"content": "build failed on main",
	"meta": {
		"sender_id": "ci",
		"severity": "high",
		"run_id": "1234"
	}
}
```

The bridge converts that to a prompt like:

```xml
<channel source="webhook" channel_id="ops" sender_id="ci" severity="high" run_id="1234">
build failed on main
</channel>
```

### `GET /channel/replies?channelId=<id>&after=<n>`

Returns stored replies for a channel. `after` is an optional sequence cursor.

## Socket.IO API

Connect to the bridge and use:

- client -> server: `subscribe({ channelId })`
- client -> server: `unsubscribe({ channelId })`
- client -> server: `channel_event({...})`
- client -> server: `get_state()`
- server -> client: `ready(...)`
- server -> client: `reply(...)`
- server -> client: `channel_error(...)`

## Reply Tool

Each `pi` RPC process loads a built-in extension from this package that adds a `channel_reply` tool. The tool posts back to the bridge's internal callback endpoint, which then:

- appends the reply to `replies.jsonl`
- emits a live Socket.IO `reply` event to subscribed clients

## Security

Channels are a prompt-injection surface. If you expose the bridge beyond localhost, gate inbound traffic before it reaches the agent.

Recommended:

- bind to `127.0.0.1` unless you truly need remote access
- use `--allow-sources`
- use `--allow-senders`
- gate on sender identity, not only channel identity

This follows the same general guidance as the Claude Channels reference: [Channels reference](https://code.claude.com/docs/en/channels-reference).
