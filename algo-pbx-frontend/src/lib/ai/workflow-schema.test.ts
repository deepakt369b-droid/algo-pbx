import { describe, expect, it } from "vitest";

import {
  AI_WORKFLOW_SCHEMA_VERSION,
  hasBlockingIssues,
  parseWorkflowDraft,
  parseWorkflowForPublish,
  validateWorkflowGraph,
  type WorkflowEdge,
  type WorkflowNode,
} from "./workflow-schema";

function startNode(id = "start", overrides: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    kind: "START_CALL",
    id,
    label: "Start",
    position: { x: 0, y: 0 },
    prompt: "",
    allowInterruption: true,
    variables: [],
    modelOverride: {},
    ...overrides,
  } as WorkflowNode;
}

function agentNode(id: string, overrides: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    kind: "AGENT",
    id,
    label: id,
    position: { x: 0, y: 0 },
    prompt: "Ask the caller their name.",
    allowInterruption: true,
    variables: [],
    modelOverride: {},
    ...overrides,
  } as WorkflowNode;
}

function endNode(id: string): WorkflowNode {
  return {
    kind: "END_CALL",
    id,
    label: "End",
    position: { x: 0, y: 0 },
    prompt: "Goodbye.",
    allowInterruption: true,
    variables: [],
    modelOverride: {},
  } as WorkflowNode;
}

function edge(id: string, source: string, target: string, condition = "always"): WorkflowEdge {
  return { id, source, target, condition };
}

function minimalValidGraph() {
  const nodes = [startNode(), agentNode("ask"), endNode("end")];
  const edges = [edge("e1", "start", "ask"), edge("e2", "ask", "end", "caller is done")];
  return { nodes, edges };
}

describe("validateWorkflowGraph", () => {
  it("accepts a minimal valid graph with no issues", () => {
    const { nodes, edges } = minimalValidGraph();
    expect(validateWorkflowGraph(nodes, edges)).toEqual([]);
  });

  it("requires exactly one START_CALL node - none", () => {
    const { edges } = minimalValidGraph();
    const nodes = [agentNode("ask"), endNode("end")];
    const issues = validateWorkflowGraph(nodes, edges);
    expect(issues.some((i) => i.message.includes("Start Call node"))).toBe(true);
  });

  it("requires exactly one START_CALL node - two", () => {
    const { nodes, edges } = minimalValidGraph();
    nodes.push(startNode("start2"));
    const issues = validateWorkflowGraph(nodes, edges);
    expect(issues.some((i) => i.message === "Only one Start Call node is allowed.")).toBe(true);
  });

  it("rejects an edge whose source does not exist", () => {
    const { nodes } = minimalValidGraph();
    const issues = validateWorkflowGraph(nodes, [edge("e1", "ghost", "ask")]);
    expect(issues.some((i) => i.path === "e1" && i.message.includes("does not exist"))).toBe(true);
  });

  it("rejects an edge whose target does not exist", () => {
    const { nodes } = minimalValidGraph();
    const issues = validateWorkflowGraph(nodes, [edge("e1", "start", "ghost")]);
    expect(issues.some((i) => i.path === "e1" && i.message.includes("does not exist"))).toBe(true);
  });

  it("rejects a self-edge", () => {
    const { nodes } = minimalValidGraph();
    const issues = validateWorkflowGraph(nodes, [edge("e1", "start", "start")]);
    expect(issues.some((i) => i.message === "A node cannot connect to itself.")).toBe(true);
  });

  it("allows at most one GLOBAL node", () => {
    const { nodes, edges } = minimalValidGraph();
    nodes.push({ kind: "GLOBAL", id: "g1", label: "Global", position: { x: 0, y: 0 }, prompt: "Be polite.", allowInterruption: true, variables: [], modelOverride: {} } as WorkflowNode);
    nodes.push({ kind: "GLOBAL", id: "g2", label: "Global2", position: { x: 0, y: 0 }, prompt: "Also this.", allowInterruption: true, variables: [], modelOverride: {} } as WorkflowNode);
    const issues = validateWorkflowGraph(nodes, edges);
    expect(issues.some((i) => i.message === "Only one Global node is allowed.")).toBe(true);
  });

  it("rejects an outgoing edge from a GLOBAL node", () => {
    const { nodes, edges } = minimalValidGraph();
    nodes.push({ kind: "GLOBAL", id: "g1", label: "Global", position: { x: 0, y: 0 }, prompt: "Be polite.", allowInterruption: true, variables: [], modelOverride: {} } as WorkflowNode);
    edges.push(edge("e3", "g1", "ask"));
    const issues = validateWorkflowGraph(nodes, edges);
    expect(issues.some((i) => i.path === "g1" && i.message.includes("Global node cannot have outgoing"))).toBe(true);
  });

  it("rejects an outgoing edge from END_CALL and TRANSFER", () => {
    const nodes = [startNode(), endNode("end"), { kind: "TRANSFER", id: "t1", label: "Transfer", position: { x: 0, y: 0 }, prompt: "", allowInterruption: true, variables: [], modelOverride: {}, transferTargetKind: null, transferNumberE164: null, transferExtensionId: null } as WorkflowNode];
    const edges = [edge("e1", "start", "end"), edge("e2", "end", "t1"), edge("e3", "t1", "end")];
    const issues = validateWorkflowGraph(nodes, edges);
    expect(issues.filter((i) => i.message.includes("terminal and cannot have outgoing"))).toHaveLength(2);
  });

  it("requires a non-empty prompt on AGENT nodes", () => {
    const { edges } = minimalValidGraph();
    const nodes = [startNode(), agentNode("ask", { prompt: "" }), endNode("end")];
    const issues = validateWorkflowGraph(nodes, edges);
    expect(issues.some((i) => i.path === "ask" && i.message === "Agent node needs a prompt.")).toBe(true);
  });

  it("requires at least one outgoing edge on AGENT nodes", () => {
    const nodes = [startNode(), agentNode("ask"), endNode("end")];
    const issues = validateWorkflowGraph(nodes, [edge("e1", "start", "ask")]);
    expect(issues.some((i) => i.path === "ask" && i.message.includes("dead-end"))).toBe(true);
  });

  it("requires at least one outgoing edge on HTTP_TOOL nodes", () => {
    const httpNode = {
      kind: "HTTP_TOOL",
      id: "http1",
      label: "Lookup",
      position: { x: 0, y: 0 },
      prompt: "",
      allowInterruption: true,
      variables: [],
      modelOverride: {},
      method: "GET",
      urlTemplate: "https://api.example.com/x",
      headers: [],
      bodyTemplate: null,
      timeoutMs: 5000,
      responseMapping: [],
    } as WorkflowNode;
    const nodes = [startNode(), httpNode, endNode("end")];
    const issues = validateWorkflowGraph(nodes, [edge("e1", "start", "http1")]);
    expect(issues.some((i) => i.path === "http1" && i.message.includes("dead-end"))).toBe(true);
  });

  it("rejects duplicate edge conditions from the same source node", () => {
    const { nodes } = minimalValidGraph();
    const edges = [
      edge("e1", "start", "ask"),
      edge("e2", "ask", "end", "caller is done"),
      edge("e3", "ask", "start", "caller is done"),
    ];
    const issues = validateWorkflowGraph(nodes, edges);
    expect(issues.some((i) => i.path === "ask" && i.message.includes("cannot tell them apart"))).toBe(true);
  });

  it("flags an unreachable node as a warning, not an error", () => {
    const { nodes, edges } = minimalValidGraph();
    // Give the orphan its own outgoing edge to a valid terminal so the ONLY
    // issue it triggers is unreachability, not also "no outgoing edges".
    nodes.push(agentNode("orphan"), endNode("orphan-end"));
    edges.push(edge("e-orphan", "orphan", "orphan-end", "done"));
    const issues = validateWorkflowGraph(nodes, edges);
    const orphanIssue = issues.find((i) => i.path === "orphan");
    expect(orphanIssue?.severity).toBe("warning");
  });

  it("does not flag the GLOBAL node as unreachable (it is not part of the traversal graph)", () => {
    const { nodes, edges } = minimalValidGraph();
    nodes.push({ kind: "GLOBAL", id: "g1", label: "Global", position: { x: 0, y: 0 }, prompt: "Be polite.", allowInterruption: true, variables: [], modelOverride: {} } as WorkflowNode);
    const issues = validateWorkflowGraph(nodes, edges);
    expect(issues.some((i) => i.path === "g1")).toBe(false);
  });

  it("requires at least one reachable terminal node", () => {
    const nodes = [startNode(), agentNode("ask", { prompt: "loop forever" })];
    const edges = [edge("e1", "start", "ask"), edge("e2", "ask", "start", "loop")];
    const issues = validateWorkflowGraph(nodes, edges);
    expect(issues.some((i) => i.message.includes("could never end"))).toBe(true);
  });

  it("resolves {{gathered_context.X}} against a declared variable", () => {
    const nodes = [
      startNode(),
      agentNode("ask", { variables: [{ name: "caller_name", type: "string", prompt: "extract the name" }] }),
      agentNode("greet", { prompt: "Hi {{gathered_context.caller_name}}, how can I help?" }),
      endNode("end"),
    ];
    const edges = [edge("e1", "start", "ask"), edge("e2", "ask", "greet", "got name"), edge("e3", "greet", "end", "done")];
    expect(validateWorkflowGraph(nodes, edges)).toEqual([]);
  });

  it("rejects {{gathered_context.X}} for an undeclared variable", () => {
    const nodes = [startNode(), agentNode("greet", { prompt: "Hi {{gathered_context.nope}}!" }), endNode("end")];
    const edges = [edge("e1", "start", "greet"), edge("e2", "greet", "end", "done")];
    const issues = validateWorkflowGraph(nodes, edges);
    expect(issues.some((i) => i.message.includes("not declared as a variable"))).toBe(true);
  });

  it("accepts an allowlisted {{initial_context.X}} field", () => {
    const nodes = [startNode(), agentNode("greet", { prompt: "Hi caller at {{initial_context.caller_number}}." }), endNode("end")];
    const edges = [edge("e1", "start", "greet"), edge("e2", "greet", "end", "done")];
    expect(validateWorkflowGraph(nodes, edges)).toEqual([]);
  });

  it("rejects a non-allowlisted {{initial_context.X}} field", () => {
    const nodes = [startNode(), agentNode("greet", { prompt: "{{initial_context.credit_card}}" }), endNode("end")];
    const edges = [edge("e1", "start", "greet"), edge("e2", "greet", "end", "done")];
    const issues = validateWorkflowGraph(nodes, edges);
    expect(issues.some((i) => i.message.includes("not a recognized field"))).toBe(true);
  });

  it("rejects a template ref with an unknown scope", () => {
    const nodes = [startNode(), agentNode("greet", { prompt: "{{mystery.thing}}" }), endNode("end")];
    const edges = [edge("e1", "start", "greet"), edge("e2", "greet", "end", "done")];
    const issues = validateWorkflowGraph(nodes, edges);
    expect(issues.some((i) => i.message.includes('must start with "gathered_context." or "initial_context."'))).toBe(true);
  });
});

describe("parseWorkflowDraft", () => {
  it("stores an invalid graph anyway (lenient parse) and reports issues", () => {
    const result = parseWorkflowDraft({
      schemaVersion: AI_WORKFLOW_SCHEMA_VERSION,
      nodes: [],
      edges: [],
    });
    // zod's `.min(1)` on nodes fails structurally, so graph is null here -
    // this IS the "not even structurally parseable" case, contrasted with
    // the next test where structure is fine but semantics aren't.
    expect(result.graph).toBeNull();
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("parses a structurally valid but semantically broken graph and still returns it", () => {
    const { nodes, edges } = minimalValidGraph();
    nodes.push(agentNode("orphan", { prompt: "" })); // structurally fine, semantically broken (empty prompt + unreachable)
    const result = parseWorkflowDraft({ schemaVersion: AI_WORKFLOW_SCHEMA_VERSION, nodes, edges });
    expect(result.graph).not.toBeNull();
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("rejects an unrecognized schemaVersion", () => {
    const { nodes, edges } = minimalValidGraph();
    const result = parseWorkflowDraft({ schemaVersion: 2, nodes, edges });
    expect(result.graph).toBeNull();
  });
});

describe("parseWorkflowForPublish", () => {
  it("blocks publish when blocking issues exist", () => {
    const { nodes, edges } = minimalValidGraph();
    nodes.push(agentNode("orphan", { prompt: "" }));
    const result = parseWorkflowForPublish(
      { schemaVersion: AI_WORKFLOW_SCHEMA_VERSION, nodes, edges },
      { pipelineMode: "CASCADE" },
    );
    expect(hasBlockingIssues(result.issues)).toBe(true);
  });

  it("allows publish for a clean CASCADE graph", () => {
    const { nodes, edges } = minimalValidGraph();
    const result = parseWorkflowForPublish(
      { schemaVersion: AI_WORKFLOW_SCHEMA_VERSION, nodes, edges },
      { pipelineMode: "CASCADE" },
    );
    expect(hasBlockingIssues(result.issues)).toBe(false);
  });

  it("allows publish for a clean REALTIME graph on OpenAI", () => {
    const { nodes, edges } = minimalValidGraph();
    const result = parseWorkflowForPublish(
      { schemaVersion: AI_WORKFLOW_SCHEMA_VERSION, nodes, edges },
      { pipelineMode: "REALTIME", realtimeProvider: "openai" },
    );
    expect(hasBlockingIssues(result.issues)).toBe(false);
  });

  it("blocks publish for REALTIME + Gemini - it cannot update instructions mid-session", () => {
    const { nodes, edges } = minimalValidGraph();
    const result = parseWorkflowForPublish(
      { schemaVersion: AI_WORKFLOW_SCHEMA_VERSION, nodes, edges },
      { pipelineMode: "REALTIME", realtimeProvider: "gemini" },
    );
    expect(hasBlockingIssues(result.issues)).toBe(true);
    expect(result.issues.some((i) => i.message.includes("Gemini Live cannot change instructions"))).toBe(true);
  });
});
