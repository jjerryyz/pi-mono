/**
 * Tool renderers for coding-agent tools.
 *
 * These renderers handle the display of read, bash, edit, write, grep, find, ls
 * tool calls in the web UI, with support for streaming partial results.
 */

import type { ToolResultMessage } from "@mariozechner/pi-ai";
import type { ToolRenderer, ToolRenderResult } from "@mariozechner/pi-web-ui";
import { registerToolRenderer, renderCollapsibleHeader, renderHeader } from "@mariozechner/pi-web-ui";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { Code, FileCode2, FileText, FolderOpen, Pencil, Search, SquareTerminal } from "lucide";
import type { RemoteAgent } from "../remote-agent.js";

let remoteAgent: RemoteAgent | null = null;

export function setRemoteAgent(agent: RemoteAgent): void {
	remoteAgent = agent;
}

function getState(result: ToolResultMessage<any> | undefined): "inprogress" | "complete" | "error" {
	return result ? (result.isError ? "error" : "complete") : "inprogress";
}

function getTextOutput(result: ToolResultMessage<any> | undefined): string {
	if (!result) return "";
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
}

function getPartialOutput(toolCallId: string | undefined): string | null {
	if (!toolCallId || !remoteAgent) return null;
	const partial = remoteAgent.partialToolResults.get(toolCallId);
	if (!partial?.content) return null;
	return partial.content
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join("\n");
}

// =========================================================================
// Streaming Bash Renderer
// =========================================================================

class StreamingBashRenderer implements ToolRenderer<{ command: string }, any> {
	private currentToolCallId?: string;

	setToolCallId(id: string): void {
		this.currentToolCallId = id;
	}

	render(
		params: { command: string } | undefined,
		result: ToolResultMessage<any> | undefined,
		_isStreaming?: boolean,
	): ToolRenderResult {
		const state = getState(result);

		if (result && params?.command) {
			const output = getTextOutput(result);
			const combined = output ? `> ${params.command}\n\n${output}` : `> ${params.command}`;
			return {
				content: html`
					<div class="space-y-3">
						${renderHeader(state, SquareTerminal, "Running command...")}
						<console-block .content=${combined} .variant=${result.isError ? "error" : "default"}></console-block>
					</div>
				`,
				isCustom: false,
			};
		}

		if (params?.command) {
			const partialOutput = getPartialOutput(this.currentToolCallId);
			const combined = partialOutput ? `> ${params.command}\n\n${partialOutput}` : `> ${params.command}`;
			return {
				content: html`
					<div class="space-y-3">
						${renderHeader(state, SquareTerminal, "Running command...")}
						<console-block .content=${combined}></console-block>
					</div>
				`,
				isCustom: false,
			};
		}

		return { content: renderHeader(state, SquareTerminal, "Waiting for command..."), isCustom: false };
	}
}

// =========================================================================
// Edit Renderer
// =========================================================================

class EditRenderer implements ToolRenderer<{ path: string; oldText: string; newText: string }, any> {
	render(
		params: { path: string; oldText: string; newText: string } | undefined,
		result: ToolResultMessage<any> | undefined,
	): ToolRenderResult {
		const state = getState(result);
		const contentRef = createRef<HTMLElement>();
		const chevronRef = createRef<HTMLElement>();

		if (!params) {
			return { content: renderHeader(state, Pencil, "Editing file..."), isCustom: false };
		}

		const headerText = html`<span>${"Edit"} <code class="text-xs bg-secondary px-1 py-0.5 rounded">${params.path}</code></span>`;

		const oldLines = params.oldText ? params.oldText.split("\n") : [];
		const newLines = params.newText ? params.newText.split("\n") : [];

		return {
			content: html`
				<div class="space-y-0">
					${renderCollapsibleHeader(state, Pencil, headerText, contentRef, chevronRef)}
					<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-200">
						<div class="text-xs font-mono bg-secondary/50 rounded p-2 overflow-x-auto max-h-48 overflow-y-auto mt-3">
							${
								oldLines.length > 0 || newLines.length > 0
									? html`
									${oldLines.map((line) => html`<div class="text-destructive/80 whitespace-pre-wrap">- ${line}</div>`)}
									${newLines.map((line) => html`<div class="text-green-600 dark:text-green-400 whitespace-pre-wrap">+ ${line}</div>`)}
								`
									: html`<span class="text-muted-foreground">${"Waiting for diff..."}</span>`
							}
						</div>
						${result ? html`<div class="text-xs mt-1 ${result.isError ? "text-destructive" : "text-muted-foreground"}">${getTextOutput(result)}</div>` : ""}
					</div>
				</div>
			`,
			isCustom: false,
		};
	}
}

// =========================================================================
// Write Renderer
// =========================================================================

class WriteRenderer implements ToolRenderer<{ path: string; content: string }, any> {
	render(
		params: { path: string; content: string } | undefined,
		result: ToolResultMessage<any> | undefined,
	): ToolRenderResult {
		const state = getState(result);
		const contentRef = createRef<HTMLElement>();
		const chevronRef = createRef<HTMLElement>();

		if (!params) {
			return { content: renderHeader(state, FileCode2, "Writing file..."), isCustom: false };
		}

		const headerText = html`<span>${"Write"} <code class="text-xs bg-secondary px-1 py-0.5 rounded">${params.path}</code></span>`;

		const preview = params.content.length > 500 ? `${params.content.substring(0, 500)}...` : params.content;

		return {
			content: html`
				<div class="space-y-0">
					${renderCollapsibleHeader(state, FileCode2, headerText, contentRef, chevronRef)}
					<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-200">
						<div class="text-xs font-mono bg-secondary/50 rounded p-2 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap mt-3">${preview}</div>
						${result ? html`<div class="text-xs mt-1 ${result.isError ? "text-destructive" : "text-muted-foreground"}">${getTextOutput(result)}</div>` : ""}
					</div>
				</div>
			`,
			isCustom: false,
		};
	}
}

// =========================================================================
// Read Renderer
// =========================================================================

class ReadRenderer implements ToolRenderer<{ path: string; offset?: number; limit?: number }, any> {
	render(
		params: { path: string; offset?: number; limit?: number } | undefined,
		result: ToolResultMessage<any> | undefined,
	): ToolRenderResult {
		const state = getState(result);
		const contentRef = createRef<HTMLElement>();
		const chevronRef = createRef<HTMLElement>();

		if (!params) {
			return { content: renderHeader(state, FileText, "Reading file..."), isCustom: false };
		}

		let rangeText = "";
		if (params.offset || params.limit) {
			const parts: string[] = [];
			if (params.offset) parts.push(`offset: ${params.offset}`);
			if (params.limit) parts.push(`limit: ${params.limit}`);
			rangeText = ` (${parts.join(", ")})`;
		}

		const headerText = html`<span>${"Read"} <code class="text-xs bg-secondary px-1 py-0.5 rounded">${params.path}</code>${rangeText}</span>`;

		const output = getTextOutput(result);
		const preview = output.length > 500 ? `${output.substring(0, 500)}...` : output;

		return {
			content: html`
				<div class="space-y-0">
					${renderCollapsibleHeader(state, FileText, headerText, contentRef, chevronRef)}
					${
						result
							? html`<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-200">
							<div class="text-xs font-mono bg-secondary/50 rounded p-2 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap mt-3">${preview}</div>
						</div>`
							: html`<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-200"></div>`
					}
				</div>
			`,
			isCustom: false,
		};
	}
}

// =========================================================================
// Grep Renderer
// =========================================================================

class GrepRenderer implements ToolRenderer<{ pattern: string; path?: string; glob?: string }, any> {
	render(
		params: { pattern: string; path?: string; glob?: string } | undefined,
		result: ToolResultMessage<any> | undefined,
	): ToolRenderResult {
		const state = getState(result);
		const contentRef = createRef<HTMLElement>();
		const chevronRef = createRef<HTMLElement>();

		if (!params) {
			return { content: renderHeader(state, Search, "Searching..."), isCustom: false };
		}

		const scopeParts: string[] = [];
		if (params.path) scopeParts.push(params.path);
		if (params.glob) scopeParts.push(`glob: ${params.glob}`);
		const scope = scopeParts.length > 0 ? ` in ${scopeParts.join(", ")}` : "";

		const headerText = html`<span>${"Grep"} <code class="text-xs bg-secondary px-1 py-0.5 rounded">${params.pattern}</code>${scope}</span>`;

		const output = getTextOutput(result);
		const preview = output.length > 1000 ? `${output.substring(0, 1000)}...` : output;

		return {
			content: html`
				<div class="space-y-0">
					${renderCollapsibleHeader(state, Search, headerText, contentRef, chevronRef)}
					<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-200">
						${result ? html`<console-block .content=${preview} class="mt-3"></console-block>` : ""}
					</div>
				</div>
			`,
			isCustom: false,
		};
	}
}

// =========================================================================
// Find Renderer
// =========================================================================

class FindRenderer implements ToolRenderer<{ pattern: string; path?: string }, any> {
	render(
		params: { pattern: string; path?: string } | undefined,
		result: ToolResultMessage<any> | undefined,
	): ToolRenderResult {
		const state = getState(result);
		const contentRef = createRef<HTMLElement>();
		const chevronRef = createRef<HTMLElement>();

		if (!params) {
			return { content: renderHeader(state, FolderOpen, "Finding files..."), isCustom: false };
		}

		const scope = params.path ? ` in ${params.path}` : "";
		const headerText = html`<span>${"Find"} <code class="text-xs bg-secondary px-1 py-0.5 rounded">${params.pattern}</code>${scope}</span>`;

		const output = getTextOutput(result);
		const preview = output.length > 1000 ? `${output.substring(0, 1000)}...` : output;

		return {
			content: html`
				<div class="space-y-0">
					${renderCollapsibleHeader(state, FolderOpen, headerText, contentRef, chevronRef)}
					<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-200">
						${result ? html`<console-block .content=${preview} class="mt-3"></console-block>` : ""}
					</div>
				</div>
			`,
			isCustom: false,
		};
	}
}

// =========================================================================
// Ls Renderer
// =========================================================================

class LsRenderer implements ToolRenderer<{ path: string }, any> {
	render(params: { path: string } | undefined, result: ToolResultMessage<any> | undefined): ToolRenderResult {
		const state = getState(result);
		const contentRef = createRef<HTMLElement>();
		const chevronRef = createRef<HTMLElement>();

		if (!params) {
			return { content: renderHeader(state, Code, "Listing directory..."), isCustom: false };
		}

		const headerText = html`<span>${"List"} <code class="text-xs bg-secondary px-1 py-0.5 rounded">${params.path}</code></span>`;

		const output = getTextOutput(result);
		const preview = output.length > 1000 ? `${output.substring(0, 1000)}...` : output;

		return {
			content: html`
				<div class="space-y-0">
					${renderCollapsibleHeader(state, Code, headerText, contentRef, chevronRef)}
					<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-200">
						${result ? html`<console-block .content=${preview} class="mt-3"></console-block>` : ""}
					</div>
				</div>
			`,
			isCustom: false,
		};
	}
}

// =========================================================================
// Registration
// =========================================================================

const bashRenderer = new StreamingBashRenderer();

export function getBashRenderer(): StreamingBashRenderer {
	return bashRenderer;
}

export function registerCodingAgentRenderers(): void {
	registerToolRenderer("bash", bashRenderer);
	registerToolRenderer("edit", new EditRenderer());
	registerToolRenderer("write", new WriteRenderer());
	registerToolRenderer("read", new ReadRenderer());
	registerToolRenderer("grep", new GrepRenderer());
	registerToolRenderer("find", new FindRenderer());
	registerToolRenderer("ls", new LsRenderer());
}
