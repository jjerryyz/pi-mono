"""
Simple Textual chatbox for the Socket.IO RPC example server.

Prerequisites:
  pip install textual python-socketio

Start the existing RPC Socket.IO server first:
  npx tsx examples/rpc-socket.io.ts

Then run this client:
  python examples/rpc-textual-chatbox.py

Optional env:
  RPC_SOCKET_IO_URL=http://localhost:3338
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import socketio
from textual import on, work
from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.message import Message
from textual.widgets import Button, Checkbox, DirectoryTree, Footer, Header, Input, Static, TextArea


class ChatBubble(Static):
    """Small helper widget that renders one chat bubble."""

    def __init__(self, author: str, text: str = "", *, classes: str = "") -> None:
        self.author = author
        self.body = text
        super().__init__("", classes=classes)
        self._refresh()

    def append(self, delta: str) -> None:
        self.body += delta
        self._refresh()

    def set_text(self, text: str) -> None:
        self.body = text
        self._refresh()

    def _refresh(self) -> None:
        body = self.body.rstrip() or "..."
        self.update(f"{self.author}\n{body}")


class ConnectionChanged(Message):
    def __init__(self, connected: bool, detail: str) -> None:
        self.connected = connected
        self.detail = detail
        super().__init__()


class ReadyStateReceived(Message):
    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = payload
        super().__init__()


class DeltaReceived(Message):
    def __init__(self, delta_type: str, delta: str) -> None:
        self.delta_type = delta_type
        self.delta = delta
        super().__init__()


class ToolEventReceived(Message):
    def __init__(self, detail: str) -> None:
        self.detail = detail
        super().__init__()


class DoneReceived(Message):
    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = payload
        super().__init__()


class ErrorReceived(Message):
    def __init__(self, message: str) -> None:
        self.message = message
        super().__init__()


class RpcTextualChatbox(App[None]):
    CSS = """
    Screen {
        layout: vertical;
    }

    #root {
        height: 1fr;
        padding: 1;
    }

    #main-layout {
        height: 1fr;
    }

    #chat-pane {
        width: 2fr;
        min-width: 60;
        margin-right: 1;
    }

    #status {
        height: auto;
        min-height: 3;
        border: round $accent;
        padding: 0 1;
        margin-bottom: 1;
    }

    #chat-view {
        height: 1fr;
        border: round $surface;
        padding: 1;
        margin-bottom: 1;
    }

    #composer {
        height: auto;
    }

    #prompt-input {
        width: 1fr;
    }

    #controls {
        height: auto;
        margin-top: 1;
    }

    .chat-bubble {
        width: 1fr;
        height: auto;
        padding: 1;
        margin-bottom: 1;
    }

    .user {
        background: $primary 15%;
        border: round $primary;
    }

    .assistant {
        background: $success 12%;
        border: round $success;
    }

    .system {
        background: $warning 12%;
        border: round $warning;
    }

    #memory-pane {
        width: 1fr;
        min-width: 44;
    }

    .memory-section {
        border: round $surface;
        padding: 1;
        margin-bottom: 1;
    }

    #memory-md-pane {
        height: 18;
    }

    #daily-section {
        height: 1fr;
        margin-bottom: 0;
    }

    .memory-header {
        height: auto;
        margin-bottom: 1;
    }

    .memory-title {
        width: 1fr;
        content-align: left middle;
        text-style: bold;
    }

    .memory-status {
        height: auto;
        margin-bottom: 1;
        color: $text-muted;
    }

    #memory-editor,
    #daily-editor {
        height: 1fr;
    }

    #daily-browser-pane {
        width: 24;
        min-width: 20;
        margin-right: 1;
    }

    #daily-editor-pane {
        width: 1fr;
    }

    #daily-tree {
        height: 1fr;
        border: round $panel;
    }
    """

    BINDINGS = [
        ("ctrl+c", "quit", "Quit"),
    ]

    def __init__(self) -> None:
        super().__init__()
        self.url = os.environ.get("RPC_SOCKET_IO_URL", "http://localhost:3338")
        self.sio = socketio.AsyncClient(reconnection=True, reconnection_attempts=0)
        self.memory_root = Path("~/.pi/health-app-memory").expanduser()
        self.memory_file = self.memory_root / "MEMORY.md"
        self.daily_dir = self.memory_root / "daily"
        self.connected = False
        self.busy = False
        self.current_response: ChatBubble | None = None
        self.current_daily_file: Path | None = None
        self.memory_saved_text = ""
        self.daily_saved_text = ""
        self._loading_memory_editor = False
        self._loading_daily_editor = False
        self._bind_socket_events()

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        with Vertical(id="root"):
            with Horizontal(id="main-layout"):
                with Vertical(id="chat-pane"):
                    yield Static(f"Connecting to {self.url}...", id="status")
                    yield VerticalScroll(id="chat-view")
                    with Horizontal(id="composer"):
                        yield Input(placeholder="Type a message and press Enter...", id="prompt-input")
                        yield Button("Send", id="send", variant="primary")
                        yield Button("Abort", id="abort", variant="error", disabled=True)
                    with Horizontal(id="controls"):
                        yield Checkbox("Reset session on send", value=False, id="reset-on-send")
                with Vertical(id="memory-pane"):
                    with Vertical(id="memory-md-pane", classes="memory-section"):
                        with Horizontal(classes="memory-header"):
                            yield Static("MEMORY.md", classes="memory-title")
                            yield Button("Reload", id="reload-memory")
                            yield Button("Save", id="save-memory", variant="primary")
                        yield Static(str(self.memory_file), id="memory-file-status", classes="memory-status")
                        yield TextArea(
                            "",
                            id="memory-editor",
                            language="markdown",
                            soft_wrap=True,
                            show_line_numbers=True,
                            placeholder="MEMORY.md content will appear here.",
                        )
                    with Horizontal(id="daily-section", classes="memory-section"):
                        with Vertical(id="daily-browser-pane"):
                            with Horizontal(classes="memory-header"):
                                yield Static("daily", classes="memory-title")
                                yield Button("Refresh", id="refresh-daily-tree")
                            yield DirectoryTree(str(self.daily_dir), id="daily-tree")
                        with Vertical(id="daily-editor-pane"):
                            with Horizontal(classes="memory-header"):
                                yield Static("Daily file", id="daily-editor-title", classes="memory-title")
                                yield Button("Reload", id="reload-daily", disabled=True)
                                yield Button("Save", id="save-daily", variant="primary", disabled=True)
                            yield Static(
                                "Select a file from daily to edit it.",
                                id="daily-file-status",
                                classes="memory-status",
                            )
                            yield TextArea(
                                "",
                                id="daily-editor",
                                language="markdown",
                                soft_wrap=True,
                                show_line_numbers=True,
                                read_only=True,
                                placeholder="Pick a file from the daily tree.",
                            )
        yield Footer()

    async def on_mount(self) -> None:
        await self._append_system_message(
            "This demo connects to the existing Socket.IO RPC server and streams assistant deltas into the chat view."
        )
        await self._load_memory_file()
        self._set_daily_status("Select a file from daily to edit it.")
        self._sync_memory_buttons()
        self._sync_daily_buttons()
        self._sync_controls()
        self.connect_socket()

    def _bind_socket_events(self) -> None:
        @self.sio.event
        async def connect() -> None:
            self.post_message(ConnectionChanged(True, f"Connected to {self.url}"))
            await self._refresh_state()

        @self.sio.event
        async def disconnect() -> None:
            self.post_message(ConnectionChanged(False, "Disconnected from RPC server"))

        @self.sio.on("ready")
        async def on_ready(payload: dict[str, Any]) -> None:
            self.post_message(ReadyStateReceived(payload))

        @self.sio.on("delta")
        async def on_delta(payload: dict[str, Any]) -> None:
            self.post_message(DeltaReceived(str(payload.get("type", "text_delta")), str(payload.get("delta", ""))))

        @self.sio.on("tool_start")
        async def on_tool_start(payload: dict[str, Any]) -> None:
            tool_name = str(payload.get("toolName", "unknown"))
            self.post_message(ToolEventReceived(f"Running tool: {tool_name}"))

        @self.sio.on("tool_end")
        async def on_tool_end(payload: dict[str, Any]) -> None:
            tool_name = str(payload.get("toolName", "unknown"))
            is_error = bool(payload.get("isError", False))
            suffix = "failed" if is_error else "finished"
            self.post_message(ToolEventReceived(f"Tool {tool_name} {suffix}"))

        @self.sio.on("done")
        async def on_done(payload: dict[str, Any]) -> None:
            self.post_message(DoneReceived(payload))

        @self.sio.on("agent_error")
        async def on_agent_error(payload: dict[str, Any]) -> None:
            self.post_message(ErrorReceived(str(payload.get("message", "Unknown agent error"))))

    @work(exclusive=True)
    async def connect_socket(self) -> None:
        self._set_status(f"Connecting to {self.url}...")
        try:
            await self.sio.connect(self.url, transports=["websocket", "polling"])
        except Exception as error:  # pragma: no cover - runtime integration
            self.post_message(ConnectionChanged(False, f"Connection failed: {error}"))

    @work(exclusive=False)
    async def send_prompt(self, prompt: str, reset: bool) -> None:
        try:
            ack = await self.sio.call("prompt", {"message": prompt, "reset": reset}, timeout=10)
            if not isinstance(ack, dict) or not ack.get("ok", False):
                error = ack.get("error", "Prompt rejected") if isinstance(ack, dict) else "Prompt rejected"
                self.post_message(ErrorReceived(str(error)))
        except Exception as error:  # pragma: no cover - runtime integration
            self.post_message(ErrorReceived(str(error)))

    @work(exclusive=False)
    async def abort_run(self) -> None:
        try:
            ack = await self.sio.call("abort", timeout=10)
            if not isinstance(ack, dict) or not ack.get("ok", False):
                error = ack.get("error", "Abort failed") if isinstance(ack, dict) else "Abort failed"
                self.post_message(ErrorReceived(str(error)))
                return
            self._set_status("Abort requested...")
        except Exception as error:  # pragma: no cover - runtime integration
            self.post_message(ErrorReceived(str(error)))

    async def _refresh_state(self) -> None:
        try:
            state = await self.sio.call("get_state", timeout=10)
            if isinstance(state, dict) and "error" not in state:
                self.post_message(ReadyStateReceived(state))
        except Exception as error:  # pragma: no cover - runtime integration
            self.post_message(ErrorReceived(f"Could not fetch state: {error}"))

    @on(Input.Submitted, "#prompt-input")
    async def on_input_submitted(self, event: Input.Submitted) -> None:
        await self._submit_prompt(event.value)

    @on(Button.Pressed, "#send")
    async def on_send_pressed(self, _event: Button.Pressed) -> None:
        input_widget = self.query_one("#prompt-input", Input)
        await self._submit_prompt(input_widget.value)

    @on(Button.Pressed, "#abort")
    def on_abort_pressed(self, _event: Button.Pressed) -> None:
        if self.busy:
            self.abort_run()

    async def _submit_prompt(self, prompt: str) -> None:
        text = prompt.strip()
        if not text or not self.connected or self.busy:
            return

        input_widget = self.query_one("#prompt-input", Input)
        reset = self.query_one("#reset-on-send", Checkbox).value
        input_widget.clear()

        if reset:
            await self._append_system_message("Starting a fresh RPC session for the next prompt.")

        await self._append_bubble("You", text, "chat-bubble user")
        self.current_response = await self._append_bubble("Assistant", "", "chat-bubble assistant")

        self.busy = True
        self._sync_controls()
        self._set_status("Prompt sent. Waiting for streamed response...")
        self.send_prompt(text, reset)

    async def _append_system_message(self, text: str) -> None:
        await self._append_bubble("System", text, "chat-bubble system")

    async def _append_bubble(self, author: str, text: str, classes: str) -> ChatBubble:
        bubble = ChatBubble(author, text, classes=classes)
        chat_view = self.query_one("#chat-view", VerticalScroll)
        await chat_view.mount(bubble)
        chat_view.scroll_end(animate=False)
        return bubble

    def _set_status(self, text: str) -> None:
        self.query_one("#status", Static).update(text)

    def _set_memory_status(self, text: str) -> None:
        self.query_one("#memory-file-status", Static).update(text)

    def _set_daily_status(self, text: str) -> None:
        self.query_one("#daily-file-status", Static).update(text)

    def _set_daily_title(self, text: str) -> None:
        self.query_one("#daily-editor-title", Static).update(text)

    def _memory_is_dirty(self) -> bool:
        return self.query_one("#memory-editor", TextArea).text != self.memory_saved_text

    def _daily_is_dirty(self) -> bool:
        if self.current_daily_file is None:
            return False
        return self.query_one("#daily-editor", TextArea).text != self.daily_saved_text

    def _sync_memory_buttons(self) -> None:
        save_button = self.query_one("#save-memory", Button)
        save_button.disabled = not self._memory_is_dirty()

    def _sync_daily_buttons(self) -> None:
        has_file = self.current_daily_file is not None
        reload_button = self.query_one("#reload-daily", Button)
        save_button = self.query_one("#save-daily", Button)
        editor = self.query_one("#daily-editor", TextArea)
        reload_button.disabled = not has_file
        save_button.disabled = not has_file or not self._daily_is_dirty()
        editor.read_only = not has_file

    def _read_text_file(self, path: Path) -> str:
        return path.read_text(encoding="utf-8")

    async def _load_memory_file(self) -> None:
        editor = self.query_one("#memory-editor", TextArea)
        self._loading_memory_editor = True
        try:
            text = self._read_text_file(self.memory_file) if self.memory_file.exists() else ""
            editor.load_text(text)
            self.memory_saved_text = text
            status = str(self.memory_file)
            if not self.memory_file.exists():
                status = f"{self.memory_file} (missing, save to create)"
            self._set_memory_status(status)
        except Exception as error:
            editor.load_text("")
            self.memory_saved_text = ""
            self._set_memory_status(f"Could not load {self.memory_file}: {error}")
        finally:
            self._loading_memory_editor = False
            self._sync_memory_buttons()

    async def _load_daily_file(self, path: Path) -> None:
        editor = self.query_one("#daily-editor", TextArea)
        self._loading_daily_editor = True
        try:
            text = self._read_text_file(path)
            self.current_daily_file = path
            self.daily_saved_text = text
            editor.load_text(text)
            relative_path = path.relative_to(self.daily_dir) if path.is_relative_to(self.daily_dir) else path
            self._set_daily_title(f"Daily file: {relative_path}")
            self._set_daily_status(str(path))
        except Exception as error:
            self.current_daily_file = None
            self.daily_saved_text = ""
            editor.load_text("")
            self._set_daily_title("Daily file")
            self._set_daily_status(f"Could not load {path}: {error}")
        finally:
            self._loading_daily_editor = False
            self._sync_daily_buttons()

    def _save_text_file(self, path: Path, text: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def _sync_controls(self) -> None:
        input_widget = self.query_one("#prompt-input", Input)
        send_button = self.query_one("#send", Button)
        abort_button = self.query_one("#abort", Button)

        input_widget.disabled = not self.connected or self.busy
        send_button.disabled = not self.connected or self.busy
        abort_button.disabled = not self.connected or not self.busy

    def on_connection_changed(self, message: ConnectionChanged) -> None:
        self.connected = message.connected
        if not message.connected:
            self.busy = False
            self.current_response = None
        self._set_status(message.detail)
        self._sync_controls()

    def on_ready_state_received(self, message: ReadyStateReceived) -> None:
        model = message.payload.get("model") or "(none)"
        server_busy = bool(message.payload.get("busy", False))
        self.busy = server_busy
        details = f"Connected to {self.url} | model: {model} | server busy: {server_busy}"
        self._set_status(details)
        self._sync_controls()

    async def on_delta_received(self, message: DeltaReceived) -> None:
        if message.delta_type == "thinking_delta":
            self._set_status("Thinking...")
            return

        if self.current_response is None:
            self.current_response = await self._append_bubble("Assistant", "", "chat-bubble assistant")

        self.current_response.append(message.delta)
        self.query_one("#chat-view", VerticalScroll).scroll_end(animate=False)

    def on_tool_event_received(self, message: ToolEventReceived) -> None:
        self._set_status(message.detail)

    def on_done_received(self, message: DoneReceived) -> None:
        final_text = str(message.payload.get("text", "")).strip()
        model = message.payload.get("model") or "(unknown model)"

        if self.current_response is not None and final_text:
            self.current_response.set_text(final_text)

        self.busy = False
        self.current_response = None
        self._sync_controls()
        self._set_status(f"Completed with {model}")

    async def on_error_received(self, message: ErrorReceived) -> None:
        self.busy = False
        self.current_response = None
        self._sync_controls()
        self._set_status(f"Error: {message.message}")
        await self._append_system_message(f"Error: {message.message}")

    @on(Button.Pressed, "#reload-memory")
    async def on_reload_memory_pressed(self, _event: Button.Pressed) -> None:
        await self._load_memory_file()

    @on(Button.Pressed, "#save-memory")
    async def on_save_memory_pressed(self, _event: Button.Pressed) -> None:
        editor = self.query_one("#memory-editor", TextArea)
        try:
            self._save_text_file(self.memory_file, editor.text)
            self.memory_saved_text = editor.text
            self._set_memory_status(f"Saved {self.memory_file}")
        except Exception as error:
            self._set_memory_status(f"Could not save {self.memory_file}: {error}")
            await self._append_system_message(f"Error saving {self.memory_file.name}: {error}")
        self._sync_memory_buttons()

    @on(Button.Pressed, "#refresh-daily-tree")
    async def on_refresh_daily_tree_pressed(self, _event: Button.Pressed) -> None:
        daily_tree = self.query_one("#daily-tree", DirectoryTree)
        await daily_tree.reload()

    @on(DirectoryTree.FileSelected, "#daily-tree")
    async def on_daily_tree_file_selected(self, event: DirectoryTree.FileSelected) -> None:
        await self._load_daily_file(event.path)

    @on(Button.Pressed, "#reload-daily")
    async def on_reload_daily_pressed(self, _event: Button.Pressed) -> None:
        if self.current_daily_file is not None:
            await self._load_daily_file(self.current_daily_file)

    @on(Button.Pressed, "#save-daily")
    async def on_save_daily_pressed(self, _event: Button.Pressed) -> None:
        if self.current_daily_file is None:
            return
        editor = self.query_one("#daily-editor", TextArea)
        try:
            self._save_text_file(self.current_daily_file, editor.text)
            self.daily_saved_text = editor.text
            self._set_daily_status(f"Saved {self.current_daily_file}")
            await self.query_one("#daily-tree", DirectoryTree).reload()
        except Exception as error:
            self._set_daily_status(f"Could not save {self.current_daily_file}: {error}")
            await self._append_system_message(f"Error saving {self.current_daily_file.name}: {error}")
        self._sync_daily_buttons()

    @on(TextArea.Changed, "#memory-editor")
    def on_memory_editor_changed(self, _event: TextArea.Changed) -> None:
        if self._loading_memory_editor:
            return
        if self._memory_is_dirty():
            self._set_memory_status(f"{self.memory_file} (unsaved changes)")
        else:
            self._set_memory_status(str(self.memory_file))
        self._sync_memory_buttons()

    @on(TextArea.Changed, "#daily-editor")
    def on_daily_editor_changed(self, _event: TextArea.Changed) -> None:
        if self._loading_daily_editor or self.current_daily_file is None:
            return
        if self._daily_is_dirty():
            self._set_daily_status(f"{self.current_daily_file} (unsaved changes)")
        else:
            self._set_daily_status(str(self.current_daily_file))
        self._sync_daily_buttons()

    async def on_unmount(self) -> None:
        if self.sio.connected:
            await self.sio.disconnect()


if __name__ == "__main__":
    RpcTextualChatbox().run()
