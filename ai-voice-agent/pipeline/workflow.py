"""Pure, DB/network-free conversation-workflow graph interpreter helpers.

Mirrors `algo-pbx-frontend/src/lib/ai/workflow-schema.ts` field-for-field and
must not drift from that shape without a corresponding contract change on
the Next.js side - same "frozen contract" discipline `config_client.py`'s
own module docstring already carries for `AiAgentConfigResponse`. The graph
this module parses has ALREADY been strict-validated server-side at publish
time (see workflow-schema.ts's `parseWorkflowForPublish`) - this module does
not re-validate structural correctness, only defends against a clearly
malformed payload (missing keys) by raising `WorkflowParseError` rather than
crashing the call with a raw KeyError deep in a turn.

No I/O, no asyncio, no Asterisk/AMI - see pipeline/runner.py's
`_run_workflow_cascade` for where these pure functions get wired into an
actual call.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Optional

from .base import ToolSpec

TEMPLATE_REF_RE = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}")

INITIAL_CONTEXT_FIELDS = {"caller_number", "called_extension", "agent_name", "now_local"}


class WorkflowParseError(Exception):
    """Raised when a published graph payload is missing a required field -
    should never happen in production (publish already strict-validated it),
    but the runner must fail closed (fall back to SIMPLE-equivalent
    behavior) rather than crash a live call on a malformed blob."""


@dataclass(frozen=True)
class WorkflowVariable:
    name: str
    type: str  # "string" | "number" | "boolean"
    prompt: str


@dataclass(frozen=True)
class ModelOverride:
    llm_provider_id: Optional[str] = None
    llm_model: Optional[str] = None
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    tts_provider_id: Optional[str] = None
    tts_model: Optional[str] = None
    tts_voice: Optional[str] = None
    tts_speed: Optional[float] = None

    @property
    def is_empty(self) -> bool:
        return self == ModelOverride()


@dataclass(frozen=True)
class WorkflowNode:
    id: str
    kind: str  # "START_CALL" | "AGENT" | "END_CALL" | "TRANSFER" | "GLOBAL" | "HTTP_TOOL"
    label: str
    prompt: str
    allow_interruption: bool
    variables: tuple[WorkflowVariable, ...]
    model_override: ModelOverride
    # TRANSFER-only
    transfer_target_kind: Optional[str] = None
    transfer_number_e164: Optional[str] = None
    transfer_extension_id: Optional[str] = None
    # HTTP_TOOL-only
    http_method: str = "GET"
    http_url_template: str = ""
    http_headers: tuple[dict, ...] = field(default_factory=tuple)
    http_body_template: Optional[str] = None
    http_timeout_ms: int = 5000
    http_response_mapping: tuple[dict, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class WorkflowEdge:
    id: str
    source: str
    target: str
    condition: str


@dataclass(frozen=True)
class WorkflowGraph:
    nodes: tuple[WorkflowNode, ...]
    edges: tuple[WorkflowEdge, ...]

    @staticmethod
    def from_payload(payload: dict) -> "WorkflowGraph":
        try:
            nodes = tuple(_parse_node(n) for n in payload["nodes"])
            edges = tuple(
                WorkflowEdge(id=e["id"], source=e["source"], target=e["target"], condition=e["condition"])
                for e in payload["edges"]
            )
        except KeyError as exc:
            raise WorkflowParseError(f"workflow graph payload missing field: {exc}") from exc
        return WorkflowGraph(nodes=nodes, edges=edges)

    def node(self, node_id: str) -> Optional[WorkflowNode]:
        return next((n for n in self.nodes if n.id == node_id), None)

    def start_node(self) -> Optional[WorkflowNode]:
        return next((n for n in self.nodes if n.kind == "START_CALL"), None)

    def global_node(self) -> Optional[WorkflowNode]:
        return next((n for n in self.nodes if n.kind == "GLOBAL"), None)

    def outgoing_edges(self, node_id: str) -> tuple[WorkflowEdge, ...]:
        return tuple(e for e in self.edges if e.source == node_id)


def _parse_model_override(raw: Optional[dict]) -> ModelOverride:
    raw = raw or {}
    return ModelOverride(
        llm_provider_id=raw.get("llmProviderId"),
        llm_model=raw.get("llmModel"),
        temperature=raw.get("temperature"),
        max_tokens=raw.get("maxTokens"),
        tts_provider_id=raw.get("ttsProviderId"),
        tts_model=raw.get("ttsModel"),
        tts_voice=raw.get("ttsVoice"),
        tts_speed=raw.get("ttsSpeed"),
    )


def _parse_node(raw: dict) -> WorkflowNode:
    variables = tuple(
        WorkflowVariable(name=v["name"], type=v["type"], prompt=v["prompt"]) for v in raw.get("variables", [])
    )
    return WorkflowNode(
        id=raw["id"],
        kind=raw["kind"],
        label=raw.get("label", raw["id"]),
        prompt=raw.get("prompt", ""),
        allow_interruption=bool(raw.get("allowInterruption", True)),
        variables=variables,
        model_override=_parse_model_override(raw.get("modelOverride")),
        transfer_target_kind=raw.get("transferTargetKind"),
        transfer_number_e164=raw.get("transferNumberE164"),
        transfer_extension_id=raw.get("transferExtensionId"),
        http_method=raw.get("method", "GET"),
        http_url_template=raw.get("urlTemplate", ""),
        http_headers=tuple(raw.get("headers", [])),
        http_body_template=raw.get("bodyTemplate"),
        http_timeout_ms=raw.get("timeoutMs", 5000),
        http_response_mapping=tuple(raw.get("responseMapping", [])),
    )


def _slugify(text: str, max_len: int = 40) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
    return (slug or "option")[:max_len]


def pathway_tool_name(edge: WorkflowEdge) -> str:
    """Tool NAME is a readable slug of the edge's condition text plus a
    short id suffix for guaranteed uniqueness (two edges can't share a
    condition on the same node per workflow-schema.ts's own validation, but
    the suffix protects against a slug collision when two DIFFERENT
    conditions happen to slugify the same way, e.g. "Yes!" and "yes?")."""
    return f"{PATHWAY_TOOL_PREFIX}{_slugify(edge.condition)}_{edge.id[:8]}"


def pathway_tool_map(graph: WorkflowGraph, node: WorkflowNode) -> dict[str, WorkflowEdge]:
    """Name -> edge, for the runner to resolve a tool call back to the edge
    it represents without re-deriving the naming scheme itself."""
    return {pathway_tool_name(edge): edge for edge in graph.outgoing_edges(node.id)}


def pathway_tools(graph: WorkflowGraph, node: WorkflowNode) -> list[ToolSpec]:
    """One ToolSpec per outgoing edge - the model moves the conversation by
    calling one of these. Tool DESCRIPTION is the condition text verbatim -
    that string is the entire mechanism the model uses to decide which edge
    to take. Built from pathway_tool_map() so tool naming can never drift
    between what's offered to the model and what the runner can resolve
    back to an edge."""
    return [
        ToolSpec(name=name, description=edge.condition, parameters={"type": "object", "properties": {}})
        for name, edge in pathway_tool_map(graph, node).items()
    ]


# Prefix used to recognize a pathway tool call - see pathway_tool_name().
PATHWAY_TOOL_PREFIX = "goto_"

RECORD_INFO_TOOL_NAME = "record_info"


def extraction_tool(node: WorkflowNode) -> Optional[ToolSpec]:
    """A single `record_info` tool covering every variable declared on this
    node - not one tool per variable. One tool for the whole set means the
    model can report everything it has gathered so far in one call instead
    of several, which matters both for round-trip latency (see
    runner.py MAX_TOOL_ROUNDS) and for model tool-calling reliability."""
    if not node.variables:
        return None
    properties = {}
    required = []
    for v in node.variables:
        json_type = {"string": "string", "number": "number", "boolean": "boolean"}.get(v.type, "string")
        properties[v.name] = {"type": json_type, "description": v.prompt}
        required.append(v.name)
    return ToolSpec(
        name=RECORD_INFO_TOOL_NAME,
        description="Record information the caller has provided so far in this step.",
        parameters={"type": "object", "properties": properties, "required": required},
    )


HTTP_TOOL_NAME = "call_http_tool"


def http_tool_spec(node: WorkflowNode) -> Optional[ToolSpec]:
    """A no-argument ToolSpec describing an HTTP_TOOL node - the request
    shape (URL/headers/body templates) is fixed by the node itself, not
    chosen by the model, so there is nothing for the model to supply as
    arguments. The actual HTTP call happens server-side, in Next.js
    (POST /api/internal/ai/http-tool) - never in this sidecar, which runs
    with network_mode: host and must not be handed a tenant-supplied URL to
    fetch directly. See that route for the SSRF guard.

    NOTE on current usage: `pipeline/runner.py`'s v1 interpreter treats
    HTTP_TOOL nodes as fully AUTOMATIC (run on entry, no model turn/choice
    involved - see `_run_http_tool_node`/`_drain_automatic_nodes`), so this
    ToolSpec is not currently offered to any LLM call. It's kept as a public,
    tested primitive because a future increment may want a model-INVOKED
    variant (an AGENT node that can optionally call out mid-conversation
    rather than always automatically on entry) without redesigning the tool
    shape - not dead code, just not wired into the automatic-node path."""
    if node.kind != "HTTP_TOOL":
        return None
    return ToolSpec(
        name=HTTP_TOOL_NAME,
        description=f"Look up information via {node.label}.",
        parameters={"type": "object", "properties": {}},
    )


def render(template: str, initial_context: dict, gathered_context: dict) -> str:
    """Substitute `{{gathered_context.X}}` / `{{initial_context.X}}` refs.
    No expressions, no loops, no code eval - deliberately a plain string
    substitution, matching workflow-schema.ts's own TEMPLATE_REF_RE grammar
    exactly. An unresolvable reference becomes an empty string rather than
    raising - a live call must never crash mid-turn over a template typo
    that validate_workflow_graph() should have already caught at publish
    time (defense in depth, not the primary guard)."""

    def _sub(match: "re.Match[str]") -> str:
        ref = match.group(1)
        scope, _, field_name = ref.partition(".")
        if scope == "gathered_context":
            value = gathered_context.get(field_name)
        elif scope == "initial_context":
            value = initial_context.get(field_name) if field_name in INITIAL_CONTEXT_FIELDS else None
        else:
            value = None
        return "" if value is None else str(value)

    return TEMPLATE_REF_RE.sub(_sub, template)


def system_prompt_for(
    node: WorkflowNode,
    global_node: Optional[WorkflowNode],
    agent_system_prompt: str,
    initial_context: dict,
    gathered_context: dict,
) -> str:
    """Concatenation order: the agent's own top-level systemPrompt (treated
    as WORKFLOW mode's "always true" instructions, exactly the same field a
    SIMPLE agent uses) -> the GLOBAL node's prompt, if one exists -> a
    labeled separator -> the current node's own prompt. All three pieces are
    template-rendered against the same context."""
    parts = []
    if agent_system_prompt.strip():
        parts.append(render(agent_system_prompt, initial_context, gathered_context))
    if global_node is not None and global_node.prompt.strip():
        parts.append(render(global_node.prompt, initial_context, gathered_context))
    parts.append("--- Current step ---")
    parts.append(render(node.prompt, initial_context, gathered_context))
    return "\n\n".join(p for p in parts if p.strip() or p == "--- Current step ---")
