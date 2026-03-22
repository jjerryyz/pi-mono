import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const EXTENSION_NAME = "pi-channel";
const BRIDGE_URL = process.env.PI_CHANNEL_BRIDGE_URL;
const DEFAULT_CHANNEL_ID = process.env.PI_CHANNEL_CHANNEL_ID;

function buildChannelPrompt(systemPrompt: string): string {
	const lines = [
		systemPrompt,
		"",
		"## Channel",
		"External channel events may be delivered as <channel ...>...</channel> tags.",
		"Treat channel tag attributes as routing metadata such as source, channel_id, sender_id, thread_id, severity, or run_id.",
		"Use the channel_reply tool to send a response back through the bridge when you should reply externally.",
		"Do not invent routing metadata. Reuse values that appear in the current channel tag.",
	];

	if (DEFAULT_CHANNEL_ID) {
		lines.push(`This runtime is bound to channel_id="${DEFAULT_CHANNEL_ID}".`);
	}

	return lines.join("\n");
}

export default function channelExtension(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event) => {
		if (!BRIDGE_URL) {
			return;
		}

		return {
			systemPrompt: buildChannelPrompt(event.systemPrompt),
		};
	});

	pi.registerTool({
		name: "channel_reply",
		label: "Channel Reply",
		description:
			"Send a text reply back through the pi channel bridge. Use this when an inbound <channel ...> message expects an external reply.",
		promptSnippet: "channel_reply - Send a text reply back to the active external channel",
		promptGuidelines: [
			"When responding to an inbound <channel ...> message that expects an external reply, call channel_reply.",
			"Pass channel_id from the tag when you need to override the runtime default.",
		],
		parameters: Type.Object({
			text: Type.String({ description: "Reply text to send back through the channel bridge." }),
			channel_id: Type.Optional(
				Type.String({
					description: "Optional target channel ID. Defaults to the runtime-bound channel when omitted.",
				}),
			),
			thread_id: Type.Optional(Type.String({ description: "Optional thread ID or reply target." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!BRIDGE_URL) {
				return {
					content: [{ type: "text", text: "PI_CHANNEL_BRIDGE_URL is not configured." }],
					details: undefined,
					isError: true,
				};
			}

			const channelId = params.channel_id ?? DEFAULT_CHANNEL_ID;
			if (!channelId) {
				return {
					content: [
						{
							type: "text",
							text: "No channel_id was provided and this runtime is not bound to a default channel.",
						},
					],
					details: undefined,
					isError: true,
				};
			}

			const response = await fetch(`${BRIDGE_URL}/internal/reply`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
				},
				body: JSON.stringify({
					channelId,
					text: params.text,
					...(params.thread_id ? { threadId: params.thread_id } : {}),
					sessionId: ctx.sessionManager.getSessionId(),
				}),
			});

			if (!response.ok) {
				const errorText = await response.text();
				return {
					content: [{ type: "text", text: `Bridge rejected reply: ${errorText}` }],
					details: undefined,
					isError: true,
				};
			}

			return {
				content: [{ type: "text", text: `Reply queued for channel ${channelId}.` }],
				details: {
					extension: EXTENSION_NAME,
					channelId,
					threadId: params.thread_id,
				},
			};
		},
	});
}
