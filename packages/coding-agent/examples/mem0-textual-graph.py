"""
Textual graph viewer for mem0 health memory data.

Prerequisites:
  pip install textual

Run:
  python examples/mem0-textual-graph.py

Optional env:
  MEM0_STORE_PATH=~/.pi/mem0-health-memory/store.json
"""

from __future__ import annotations

import json
import os
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from rich.tree import Tree
from textual import on
from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.widgets import Button, DataTable, Footer, Header, Input, Static, TabPane, TabbedContent


@dataclass(slots=True)
class MemoryRecord:
    id: str
    text: str
    kind: str
    category: str
    tags: list[str]
    entities: list[str]
    relations: list[dict[str, str]]
    created_at: str
    updated_at: str
    raw: dict[str, Any]


@dataclass(slots=True)
class RelationRecord:
    key: str
    memory_id: str
    source: str
    target: str
    relation_type: str
    kind: str
    category: str
    memory_text: str


@dataclass(slots=True)
class NodeRecord:
    name: str
    memory_ids: list[str]
    kinds: list[str]
    categories: list[str]
    tags: list[str]
    entity_mentions: int
    outgoing_count: int
    incoming_count: int
    related_nodes: list[str]


@dataclass(slots=True)
class GraphSnapshot:
    version: int
    memories: list[MemoryRecord]
    relations: list[RelationRecord]
    nodes: list[NodeRecord]


def _as_clean_strings(values: Any) -> list[str]:
    if not isinstance(values, list):
        return []
    result: list[str] = []
    for value in values:
        text = str(value).strip()
        if text:
            result.append(text)
    return result


def _preview(text: str, width: int = 56) -> str:
    compact = " ".join(text.split())
    if len(compact) <= width:
        return compact
    return f"{compact[: width - 1]}..."


def _sort_strings(values: set[str]) -> list[str]:
    return sorted(values, key=str.casefold)


def load_graph_snapshot(store_path: Path) -> GraphSnapshot:
    data = json.loads(store_path.read_text(encoding="utf-8"))
    memories_data = data.get("memories", [])

    memories: list[MemoryRecord] = []
    relations: list[RelationRecord] = []
    node_index: dict[str, dict[str, Any]] = defaultdict(
        lambda: {
            "memory_ids": set(),
            "kinds": set(),
            "categories": set(),
            "tags": set(),
            "entity_mentions": 0,
            "outgoing_count": 0,
            "incoming_count": 0,
            "related_nodes": set(),
        }
    )

    for memory_payload in memories_data:
        if not isinstance(memory_payload, dict):
            continue

        memory_id = str(memory_payload.get("id", ""))
        text = str(memory_payload.get("text", "")).strip()
        kind = str(memory_payload.get("kind", ""))
        category = str(memory_payload.get("category", ""))
        tags = _as_clean_strings(memory_payload.get("tags", []))
        entities = _as_clean_strings(memory_payload.get("entities", []))

        relation_payloads = memory_payload.get("relations", [])
        relation_rows: list[dict[str, str]] = []
        for index, relation_payload in enumerate(relation_payloads):
            if not isinstance(relation_payload, dict):
                continue
            source = str(relation_payload.get("source", "")).strip()
            target = str(relation_payload.get("target", "")).strip()
            relation_type = str(relation_payload.get("type", "")).strip()
            if not source or not target:
                continue

            relation_row = {
                "source": source,
                "target": target,
                "type": relation_type or "related_to",
            }
            relation_rows.append(relation_row)
            relations.append(
                RelationRecord(
                    key=f"{memory_id}:{index}",
                    memory_id=memory_id,
                    source=source,
                    target=target,
                    relation_type=relation_row["type"],
                    kind=kind,
                    category=category,
                    memory_text=text,
                )
            )

            source_node = node_index[source]
            source_node["memory_ids"].add(memory_id)
            source_node["kinds"].add(kind)
            source_node["categories"].add(category)
            source_node["tags"].update(tags)
            source_node["outgoing_count"] += 1
            source_node["related_nodes"].add(target)

            target_node = node_index[target]
            target_node["memory_ids"].add(memory_id)
            target_node["kinds"].add(kind)
            target_node["categories"].add(category)
            target_node["tags"].update(tags)
            target_node["incoming_count"] += 1
            target_node["related_nodes"].add(source)

        for entity in entities:
            node = node_index[entity]
            node["memory_ids"].add(memory_id)
            node["kinds"].add(kind)
            node["categories"].add(category)
            node["tags"].update(tags)
            node["entity_mentions"] += 1

        memories.append(
            MemoryRecord(
                id=memory_id,
                text=text,
                kind=kind,
                category=category,
                tags=tags,
                entities=entities,
                relations=relation_rows,
                created_at=str(memory_payload.get("createdAt", "")),
                updated_at=str(memory_payload.get("updatedAt", "")),
                raw=memory_payload,
            )
        )

    nodes = [
        NodeRecord(
            name=name,
            memory_ids=sorted(payload["memory_ids"]),
            kinds=_sort_strings(payload["kinds"]),
            categories=_sort_strings(payload["categories"]),
            tags=_sort_strings(payload["tags"]),
            entity_mentions=int(payload["entity_mentions"]),
            outgoing_count=int(payload["outgoing_count"]),
            incoming_count=int(payload["incoming_count"]),
            related_nodes=_sort_strings(payload["related_nodes"]),
        )
        for name, payload in node_index.items()
    ]

    memories.sort(key=lambda memory: (memory.kind.casefold(), memory.category.casefold(), memory.id.casefold()))
    relations.sort(
        key=lambda relation: (
            relation.relation_type.casefold(),
            relation.source.casefold(),
            relation.target.casefold(),
            relation.memory_id.casefold(),
        )
    )
    nodes.sort(key=lambda node: node.name.casefold())

    return GraphSnapshot(
        version=int(data.get("version", 0)),
        memories=memories,
        relations=relations,
        nodes=nodes,
    )


class Mem0GraphApp(App[None]):
    CSS = """
    Screen {
        layout: vertical;
    }

    #root {
        height: 1fr;
        padding: 1;
    }

    #summary {
        height: auto;
        border: round $accent;
        padding: 0 1;
        margin-bottom: 1;
    }

    #controls {
        height: auto;
        margin-bottom: 1;
    }

    #filter-input {
        width: 1fr;
        margin-right: 1;
    }

    #content {
        height: 1fr;
    }

    #tables-pane {
        width: 3fr;
        min-width: 72;
        margin-right: 1;
    }

    #detail-pane {
        width: 2fr;
        min-width: 42;
        border: round $surface;
        padding: 1;
    }

    .table-panel {
        height: 1fr;
    }

    .graph-table {
        height: 1fr;
    }

    .section-title {
        text-style: bold;
        margin-bottom: 1;
    }

    #detail-scroll {
        height: 1fr;
        border: round $panel;
        padding: 1;
    }

    #detail-body {
        width: 1fr;
    }
    """

    BINDINGS = [
        ("ctrl+r", "reload", "Reload"),
        ("ctrl+c", "quit", "Quit"),
    ]

    def __init__(self) -> None:
        super().__init__()
        self.store_path = Path(os.environ.get("MEM0_STORE_PATH", "~/.pi/mem0-health-memory/store.json")).expanduser()
        self.snapshot = GraphSnapshot(version=0, memories=[], relations=[], nodes=[])
        self.filter_text = ""
        self.selected_kind: str | None = None
        self.selected_key: str | None = None
        self.memory_rows: dict[str, MemoryRecord] = {}
        self.node_rows: dict[str, NodeRecord] = {}
        self.relation_rows: dict[str, RelationRecord] = {}

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        with Vertical(id="root"):
            yield Static("Loading graph data...", id="summary")
            with Horizontal(id="controls"):
                yield Input(placeholder="Filter by text, entity, relation, tag...", id="filter-input")
                yield Button("Reload", id="reload", variant="primary")
            with Horizontal(id="content"):
                with Vertical(id="tables-pane"):
                    with TabbedContent(initial="memories"):
                        with TabPane("Memories", id="memories"):
                            yield DataTable(id="memories-table", classes="graph-table table-panel")
                        with TabPane("Nodes", id="nodes"):
                            yield DataTable(id="nodes-table", classes="graph-table table-panel")
                        with TabPane("Edges", id="edges"):
                            yield DataTable(id="edges-table", classes="graph-table table-panel")
                        with TabPane("Graph", id="graph"):
                            with VerticalScroll(id="graph-scroll", classes="table-panel"):
                                yield Static("Graph view will appear here.", id="graph-view")
                with Vertical(id="detail-pane"):
                    yield Static("Selection", classes="section-title")
                    with VerticalScroll(id="detail-scroll"):
                        yield Static("Select a memory, node, or edge to inspect it.", id="detail-body")
        yield Footer()

    def on_mount(self) -> None:
        self._configure_tables()
        self._reload_graph()

    def _configure_tables(self) -> None:
        memories_table = self.query_one("#memories-table", DataTable)
        memories_table.cursor_type = "row"
        memories_table.zebra_stripes = True
        memories_table.add_columns("ID", "Kind", "Category", "Entities", "Edges", "Text")

        nodes_table = self.query_one("#nodes-table", DataTable)
        nodes_table.cursor_type = "row"
        nodes_table.zebra_stripes = True
        nodes_table.add_columns("Node", "Memories", "Outgoing", "Incoming", "Entity Mentions")

        edges_table = self.query_one("#edges-table", DataTable)
        edges_table.cursor_type = "row"
        edges_table.zebra_stripes = True
        edges_table.add_columns("Source", "Type", "Target", "Memory", "Category")

    def action_reload(self) -> None:
        self._reload_graph()

    @on(Button.Pressed, "#reload")
    def on_reload_pressed(self, _event: Button.Pressed) -> None:
        self._reload_graph()

    @on(Input.Changed, "#filter-input")
    def on_filter_changed(self, event: Input.Changed) -> None:
        self.filter_text = event.value.strip().casefold()
        self._refresh_tables()

    def _reload_graph(self) -> None:
        try:
            self.snapshot = load_graph_snapshot(self.store_path)
        except FileNotFoundError:
            self.snapshot = GraphSnapshot(version=0, memories=[], relations=[], nodes=[])
            self._update_summary(f"Missing store file: {self.store_path}")
            self._set_detail("Store file not found.\n\nSet MEM0_STORE_PATH or create the JSON file first.")
            self._refresh_tables()
            self._refresh_graph_view()
            return
        except json.JSONDecodeError as error:
            self.snapshot = GraphSnapshot(version=0, memories=[], relations=[], nodes=[])
            self._update_summary(f"Invalid JSON in {self.store_path}: {error}")
            self._set_detail(f"Could not parse JSON.\n\n{error}")
            self._refresh_tables()
            self._refresh_graph_view()
            return
        except Exception as error:
            self.snapshot = GraphSnapshot(version=0, memories=[], relations=[], nodes=[])
            self._update_summary(f"Could not load {self.store_path}: {error}")
            self._set_detail(f"Unexpected error while reading graph data.\n\n{error}")
            self._refresh_tables()
            self._refresh_graph_view()
            return

        self._refresh_tables()
        self._refresh_graph_view()
        self._set_detail(
            "\n".join(
                [
                    "Graph data loaded.",
                    "",
                    f"Store: {self.store_path}",
                    f"Version: {self.snapshot.version}",
                    f"Memories: {len(self.snapshot.memories)}",
                    f"Nodes: {len(self.snapshot.nodes)}",
                    f"Edges: {len(self.snapshot.relations)}",
                    "",
                    "Use the filter box to narrow rows.",
                    "Select a row in any table to inspect details.",
                    "Open the Graph tab for a node-link view.",
                ]
            )
        )

    def _matches_memory(self, memory: MemoryRecord) -> bool:
        if not self.filter_text:
            return True
        parts = [
            memory.id,
            memory.text,
            memory.kind,
            memory.category,
            " ".join(memory.tags),
            " ".join(memory.entities),
            " ".join(
                f"{relation['source']} {relation['type']} {relation['target']}" for relation in memory.relations
            ),
        ]
        haystack = " ".join(parts).casefold()
        return self.filter_text in haystack

    def _matches_node(self, node: NodeRecord) -> bool:
        if not self.filter_text:
            return True
        parts = [
            node.name,
            " ".join(node.memory_ids),
            " ".join(node.kinds),
            " ".join(node.categories),
            " ".join(node.tags),
            " ".join(node.related_nodes),
        ]
        haystack = " ".join(parts).casefold()
        return self.filter_text in haystack

    def _matches_relation(self, relation: RelationRecord) -> bool:
        if not self.filter_text:
            return True
        parts = [
            relation.source,
            relation.target,
            relation.relation_type,
            relation.memory_id,
            relation.kind,
            relation.category,
            relation.memory_text,
        ]
        haystack = " ".join(parts).casefold()
        return self.filter_text in haystack

    def _refresh_tables(self) -> None:
        filtered_memories = [memory for memory in self.snapshot.memories if self._matches_memory(memory)]
        filtered_nodes = [node for node in self.snapshot.nodes if self._matches_node(node)]
        filtered_relations = [relation for relation in self.snapshot.relations if self._matches_relation(relation)]

        self.memory_rows = {memory.id: memory for memory in filtered_memories}
        self.node_rows = {node.name: node for node in filtered_nodes}
        self.relation_rows = {relation.key: relation for relation in filtered_relations}

        memories_table = self.query_one("#memories-table", DataTable)
        memories_table.clear(columns=False)
        for memory in filtered_memories:
            memories_table.add_row(
                memory.id.replace("mem_", "", 1),
                memory.kind,
                memory.category,
                str(len(memory.entities)),
                str(len(memory.relations)),
                _preview(memory.text),
                key=memory.id,
            )

        nodes_table = self.query_one("#nodes-table", DataTable)
        nodes_table.clear(columns=False)
        for node in filtered_nodes:
            nodes_table.add_row(
                node.name,
                str(len(node.memory_ids)),
                str(node.outgoing_count),
                str(node.incoming_count),
                str(node.entity_mentions),
                key=node.name,
            )

        edges_table = self.query_one("#edges-table", DataTable)
        edges_table.clear(columns=False)
        for relation in filtered_relations:
            edges_table.add_row(
                relation.source,
                relation.relation_type,
                relation.target,
                relation.memory_id.replace("mem_", "", 1),
                relation.category,
                key=relation.key,
            )

        self._update_summary(
            " | ".join(
                [
                    f"store: {self.store_path}",
                    f"version: {self.snapshot.version}",
                    f"memories: {len(filtered_memories)}/{len(self.snapshot.memories)}",
                    f"nodes: {len(filtered_nodes)}/{len(self.snapshot.nodes)}",
                    f"edges: {len(filtered_relations)}/{len(self.snapshot.relations)}",
                ]
            )
        )
        self._refresh_graph_view()

    def _update_summary(self, text: str) -> None:
        self.query_one("#summary", Static).update(text)

    def _set_detail(self, text: str) -> None:
        self.query_one("#detail-body", Static).update(text)

    def _refresh_graph_view(self) -> None:
        self.query_one("#graph-view", Static).update(self._build_graph_tree())

    def _build_graph_tree(self) -> Tree:
        if self.selected_kind == "node" and self.selected_key in self.node_rows:
            return self._build_node_focus_tree(self.node_rows[self.selected_key])
        if self.selected_kind == "memory" and self.selected_key in self.memory_rows:
            return self._build_memory_focus_tree(self.memory_rows[self.selected_key])
        if self.selected_kind == "relation" and self.selected_key in self.relation_rows:
            return self._build_relation_focus_tree(self.relation_rows[self.selected_key])
        return self._build_overview_tree()

    def _active_relations(self) -> list[RelationRecord]:
        return list(self.relation_rows.values())

    def _active_nodes(self) -> list[NodeRecord]:
        return list(self.node_rows.values())

    def _short_memory_id(self, memory_id: str) -> str:
        return memory_id.replace("mem_", "", 1)

    def _node_score(self, node: NodeRecord) -> int:
        return node.outgoing_count + node.incoming_count + node.entity_mentions

    def _build_overview_tree(self) -> Tree:
        root = Tree(
            f"Filtered graph: {len(self.node_rows)} nodes, {len(self.relation_rows)} edges, {len(self.memory_rows)} memories"
        )
        if not self.node_rows:
            root.add("No nodes match the current filter.")
            return root

        ranked_nodes = sorted(self._active_nodes(), key=lambda node: (-self._node_score(node), node.name.casefold()))
        visible_nodes = ranked_nodes[:18]
        for node in visible_nodes:
            branch = root.add(
                f"{node.name}  [memories={len(node.memory_ids)} out={node.outgoing_count} in={node.incoming_count}]"
            )
            outgoing = [relation for relation in self._active_relations() if relation.source == node.name][:6]
            incoming = [relation for relation in self._active_relations() if relation.target == node.name][:4]

            if outgoing:
                out_branch = branch.add("outgoing")
                for relation in outgoing:
                    out_branch.add(
                        f"{relation.relation_type} -> {relation.target}  (memory {self._short_memory_id(relation.memory_id)})"
                    )

            if incoming:
                in_branch = branch.add("incoming")
                for relation in incoming:
                    in_branch.add(
                        f"{relation.source} -> {relation.relation_type}  (memory {self._short_memory_id(relation.memory_id)})"
                    )

            if not outgoing and not incoming:
                branch.add("isolated entity node")

            related_preview = node.related_nodes[:8]
            if related_preview:
                branch.add(f"neighbors: {', '.join(related_preview)}")

        hidden_count = len(ranked_nodes) - len(visible_nodes)
        if hidden_count > 0:
            root.add(f"... {hidden_count} more nodes not shown")

        return root

    def _build_node_focus_tree(self, node: NodeRecord) -> Tree:
        root = Tree(
            f"Node: {node.name}  [memories={len(node.memory_ids)} out={node.outgoing_count} in={node.incoming_count}]"
        )
        outgoing = [relation for relation in self._active_relations() if relation.source == node.name]
        incoming = [relation for relation in self._active_relations() if relation.target == node.name]

        outgoing_branch = root.add("outgoing edges")
        if outgoing:
            for relation in outgoing:
                outgoing_branch.add(
                    f"{relation.relation_type} -> {relation.target}  (memory {self._short_memory_id(relation.memory_id)})"
                )
        else:
            outgoing_branch.add("none")

        incoming_branch = root.add("incoming edges")
        if incoming:
            for relation in incoming:
                incoming_branch.add(
                    f"{relation.source} -[{relation.relation_type}]-> {node.name}  (memory {self._short_memory_id(relation.memory_id)})"
                )
        else:
            incoming_branch.add("none")

        entity_branch = root.add("entity metadata")
        entity_branch.add(f"mentions: {node.entity_mentions}")
        entity_branch.add(f"kinds: {', '.join(node.kinds) if node.kinds else '-'}")
        entity_branch.add(f"categories: {', '.join(node.categories) if node.categories else '-'}")
        entity_branch.add(f"tags: {', '.join(node.tags) if node.tags else '-'}")

        memories_branch = root.add("memory ids")
        for memory_id in node.memory_ids[:12]:
            memories_branch.add(memory_id)
        if len(node.memory_ids) > 12:
            memories_branch.add(f"... {len(node.memory_ids) - 12} more")

        return root

    def _build_memory_focus_tree(self, memory: MemoryRecord) -> Tree:
        root = Tree(f"Memory: {self._short_memory_id(memory.id)}  [{memory.kind or '-'} / {memory.category or '-'}]")
        root.add(f"text: {_preview(memory.text, 72) or '-'}")

        entities_branch = root.add(f"entities ({len(memory.entities)})")
        if memory.entities:
            for entity in memory.entities:
                entities_branch.add(entity)
        else:
            entities_branch.add("none")

        relations_branch = root.add(f"edges ({len(memory.relations)})")
        if memory.relations:
            for relation in memory.relations:
                relations_branch.add(f"{relation['source']} -[{relation['type']}]-> {relation['target']}")
        else:
            relations_branch.add("none")

        return root

    def _build_relation_focus_tree(self, relation: RelationRecord) -> Tree:
        root = Tree(
            f"Edge: {relation.source} -[{relation.relation_type}]-> {relation.target}"
        )
        root.add(f"memory: {self._short_memory_id(relation.memory_id)}")
        root.add(f"kind/category: {relation.kind or '-'} / {relation.category or '-'}")
        root.add(f"text: {_preview(relation.memory_text, 72) or '-'}")

        source_neighbors = root.add("source neighbors")
        source_edges = [item for item in self._active_relations() if item.source == relation.source][:8]
        if source_edges:
            for item in source_edges:
                source_neighbors.add(f"{item.relation_type} -> {item.target}")
        else:
            source_neighbors.add("none")

        target_neighbors = root.add("target incoming")
        target_edges = [item for item in self._active_relations() if item.target == relation.target][:8]
        if target_edges:
            for item in target_edges:
                target_neighbors.add(f"{item.source} -[{item.relation_type}]-> {item.target}")
        else:
            target_neighbors.add("none")

        return root

    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        table_id = event.data_table.id or ""
        row_key = str(event.row_key.value)

        if table_id == "memories-table" and row_key in self.memory_rows:
            self.selected_kind = "memory"
            self.selected_key = row_key
            self._set_detail(self._format_memory_detail(self.memory_rows[row_key]))
        elif table_id == "nodes-table" and row_key in self.node_rows:
            self.selected_kind = "node"
            self.selected_key = row_key
            self._set_detail(self._format_node_detail(self.node_rows[row_key]))
        elif table_id == "edges-table" and row_key in self.relation_rows:
            self.selected_kind = "relation"
            self.selected_key = row_key
            self._set_detail(self._format_relation_detail(self.relation_rows[row_key]))
        else:
            return

        self._refresh_graph_view()

    def _format_memory_detail(self, memory: MemoryRecord) -> str:
        lines = [
            "Memory",
            "",
            f"id: {memory.id}",
            f"kind: {memory.kind or '-'}",
            f"category: {memory.category or '-'}",
            f"createdAt: {memory.created_at or '-'}",
            f"updatedAt: {memory.updated_at or '-'}",
            "",
            "text:",
            memory.text or "-",
            "",
            f"tags ({len(memory.tags)}): {', '.join(memory.tags) if memory.tags else '-'}",
            f"entities ({len(memory.entities)}): {', '.join(memory.entities) if memory.entities else '-'}",
            "",
            f"edges ({len(memory.relations)}):",
        ]
        if memory.relations:
            for relation in memory.relations:
                lines.append(f"- {relation['source']} -[{relation['type']}]-> {relation['target']}")
        else:
            lines.append("-")
        return "\n".join(lines)

    def _format_node_detail(self, node: NodeRecord) -> str:
        lines = [
            "Node",
            "",
            f"name: {node.name}",
            f"memories: {len(node.memory_ids)}",
            f"entity mentions: {node.entity_mentions}",
            f"outgoing edges: {node.outgoing_count}",
            f"incoming edges: {node.incoming_count}",
            "",
            f"kinds: {', '.join(node.kinds) if node.kinds else '-'}",
            f"categories: {', '.join(node.categories) if node.categories else '-'}",
            f"tags: {', '.join(node.tags) if node.tags else '-'}",
            "",
            "memory ids:",
        ]
        if node.memory_ids:
            for memory_id in node.memory_ids:
                lines.append(f"- {memory_id}")
        else:
            lines.append("-")

        lines.append("")
        lines.append("related nodes:")
        if node.related_nodes:
            for related_node in node.related_nodes:
                lines.append(f"- {related_node}")
        else:
            lines.append("-")

        return "\n".join(lines)

    def _format_relation_detail(self, relation: RelationRecord) -> str:
        return "\n".join(
            [
                "Edge",
                "",
                f"memory: {relation.memory_id}",
                f"kind: {relation.kind or '-'}",
                f"category: {relation.category or '-'}",
                "",
                f"{relation.source} -[{relation.relation_type}]-> {relation.target}",
                "",
                "memory text:",
                relation.memory_text or "-",
            ]
        )


if __name__ == "__main__":
    Mem0GraphApp().run()
