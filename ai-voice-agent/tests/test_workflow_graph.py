import pytest

from pipeline.workflow import (
    HTTP_TOOL_NAME,
    RECORD_INFO_TOOL_NAME,
    WorkflowGraph,
    WorkflowParseError,
    extraction_tool,
    http_tool_spec,
    pathway_tools,
    render,
    system_prompt_for,
)


def _node(id_, kind, **overrides):
    base = {
        "id": id_,
        "kind": kind,
        "label": id_,
        "prompt": "",
        "allowInterruption": True,
        "variables": [],
        "modelOverride": {},
    }
    base.update(overrides)
    return base


def _edge(id_, source, target, condition):
    return {"id": id_, "source": source, "target": target, "condition": condition}


def test_from_payload_parses_nodes_and_edges():
    payload = {
        "nodes": [_node("start", "START_CALL"), _node("end", "END_CALL", prompt="Bye")],
        "edges": [_edge("e1", "start", "end", "always")],
    }
    graph = WorkflowGraph.from_payload(payload)
    assert len(graph.nodes) == 2
    assert graph.start_node().id == "start"
    assert graph.node("end").prompt == "Bye"
    assert len(graph.outgoing_edges("start")) == 1
    assert graph.outgoing_edges("end") == ()


def test_from_payload_raises_workflow_parse_error_on_missing_field():
    with pytest.raises(WorkflowParseError):
        WorkflowGraph.from_payload({"nodes": [{"id": "x"}], "edges": []})


def test_from_payload_parses_variables_and_model_override():
    payload = {
        "nodes": [
            _node(
                "ask",
                "AGENT",
                prompt="Ask for their name",
                variables=[{"name": "caller_name", "type": "string", "prompt": "extract the name"}],
                modelOverride={"llmProviderId": "cred-1", "llmModel": "gpt-4o-mini", "temperature": 0.5},
            )
        ],
        "edges": [],
    }
    graph = WorkflowGraph.from_payload(payload)
    node = graph.node("ask")
    assert node.variables[0].name == "caller_name"
    assert node.model_override.llm_provider_id == "cred-1"
    assert node.model_override.temperature == 0.5
    assert node.model_override.is_empty is False


def test_model_override_is_empty_for_no_override():
    payload = {"nodes": [_node("start", "START_CALL")], "edges": []}
    graph = WorkflowGraph.from_payload(payload)
    assert graph.node("start").model_override.is_empty is True


# --- pathway_tools ----------------------------------------------------------


def test_pathway_tools_one_per_outgoing_edge_named_after_condition():
    payload = {
        "nodes": [_node("ask", "AGENT")],
        "edges": [
            _edge("e1", "ask", "yes_node", "Caller says yes"),
            _edge("e2", "ask", "no_node", "Caller says no"),
        ],
    }
    graph = WorkflowGraph.from_payload(payload)
    tools = pathway_tools(graph, graph.node("ask"))
    assert len(tools) == 2
    names = {t.name for t in tools}
    assert all(n.startswith("goto_") for n in names)
    descriptions = {t.description for t in tools}
    assert descriptions == {"Caller says yes", "Caller says no"}


def test_pathway_tools_empty_for_terminal_node():
    payload = {"nodes": [_node("end", "END_CALL")], "edges": []}
    graph = WorkflowGraph.from_payload(payload)
    assert pathway_tools(graph, graph.node("end")) == []


def test_pathway_tools_names_unique_even_for_similar_conditions():
    payload = {
        "nodes": [_node("ask", "AGENT")],
        "edges": [_edge("e1", "ask", "a", "Yes!"), _edge("e2", "ask", "b", "yes?")],
    }
    graph = WorkflowGraph.from_payload(payload)
    tools = pathway_tools(graph, graph.node("ask"))
    assert len({t.name for t in tools}) == 2  # names differ despite slugifying the same


# --- extraction_tool ---------------------------------------------------------


def test_extraction_tool_none_when_no_variables():
    payload = {"nodes": [_node("ask", "AGENT")], "edges": []}
    graph = WorkflowGraph.from_payload(payload)
    assert extraction_tool(graph.node("ask")) is None


def test_extraction_tool_one_tool_covers_all_variables():
    payload = {
        "nodes": [
            _node(
                "ask",
                "AGENT",
                variables=[
                    {"name": "caller_name", "type": "string", "prompt": "the name"},
                    {"name": "party_size", "type": "number", "prompt": "how many people"},
                ],
            )
        ],
        "edges": [],
    }
    graph = WorkflowGraph.from_payload(payload)
    tool = extraction_tool(graph.node("ask"))
    assert tool.name == RECORD_INFO_TOOL_NAME
    assert set(tool.parameters["properties"].keys()) == {"caller_name", "party_size"}
    assert tool.parameters["properties"]["party_size"]["type"] == "number"
    assert set(tool.parameters["required"]) == {"caller_name", "party_size"}


# --- http_tool_spec -----------------------------------------------------------


def test_http_tool_spec_only_for_http_tool_nodes():
    payload = {
        "nodes": [
            _node("ask", "AGENT"),
            _node("lookup", "HTTP_TOOL", label="Order lookup", urlTemplate="https://api.example.com/x"),
        ],
        "edges": [],
    }
    graph = WorkflowGraph.from_payload(payload)
    assert http_tool_spec(graph.node("ask")) is None
    spec = http_tool_spec(graph.node("lookup"))
    assert spec.name == HTTP_TOOL_NAME
    assert "Order lookup" in spec.description
    assert spec.parameters["properties"] == {}


# --- render -------------------------------------------------------------------


def test_render_substitutes_gathered_context():
    assert render("Hi {{gathered_context.name}}!", {}, {"name": "Sam"}) == "Hi Sam!"


def test_render_substitutes_initial_context():
    assert render("Caller: {{initial_context.caller_number}}", {"caller_number": "+123"}, {}) == "Caller: +123"


def test_render_unresolvable_ref_becomes_empty_string_not_a_crash():
    assert render("Hi {{gathered_context.nope}}!", {}, {}) == "Hi !"


def test_render_rejects_non_allowlisted_initial_context_field_silently():
    # initial_context.credit_card isn't in INITIAL_CONTEXT_FIELDS - workflow-
    # schema.ts's publish-time validator should have caught this already;
    # this module's job is only to never crash on it.
    assert render("{{initial_context.credit_card}}", {"credit_card": "1234"}, {}) == ""


def test_render_leaves_plain_text_untouched():
    assert render("No templates here.", {}, {}) == "No templates here."


def test_render_handles_multiple_refs():
    result = render("{{gathered_context.a}} and {{gathered_context.b}}", {}, {"a": "1", "b": "2"})
    assert result == "1 and 2"


# --- system_prompt_for ---------------------------------------------------------


def test_system_prompt_concatenates_agent_global_and_node_prompts_in_order():
    payload = {
        "nodes": [
            _node("g", "GLOBAL", prompt="Always be polite."),
            _node("ask", "AGENT", prompt="Ask {{gathered_context.topic}}"),
        ],
        "edges": [],
    }
    graph = WorkflowGraph.from_payload(payload)
    result = system_prompt_for(
        graph.node("ask"), graph.global_node(), "You are a support agent.", {}, {"topic": "billing"}
    )
    assert result.index("You are a support agent.") < result.index("Always be polite.")
    assert result.index("Always be polite.") < result.index("--- Current step ---")
    assert "Ask billing" in result


def test_system_prompt_omits_global_section_when_no_global_node():
    payload = {"nodes": [_node("ask", "AGENT", prompt="Ask something")], "edges": []}
    graph = WorkflowGraph.from_payload(payload)
    result = system_prompt_for(graph.node("ask"), None, "Base prompt", {}, {})
    assert "Base prompt" in result
    assert "Ask something" in result
