import type { RiskGraph } from "../../../domain/interfaces/i.riskLink";

export interface VendorOption {
  id: number;
  name: string | null;
}

/** The vendors that have at least one risk on the map, by name. */
export function vendorsOnMap(graph: RiskGraph): VendorOption[] {
  const byId = new Map<number, VendorOption>();
  for (const node of graph.nodes) {
    if (node.entityType === "vendor_risk" && node.vendor) byId.set(node.vendor.id, node.vendor);
  }
  return [...byId.values()].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
}

/**
 * One vendor's part of the map: its vendor risks, the project risks that
 * inherit from them, and any link among those. A child's links to risks
 * outside that set are left out; selecting the child on the full map shows
 * them.
 */
export function vendorSubgraph(graph: RiskGraph, vendorId: number): RiskGraph {
  const vendorKeys = new Set(
    graph.nodes
      .filter((node) => node.entityType === "vendor_risk" && node.vendor?.id === vendorId)
      .map((node) => node.key),
  );
  const kept = new Set(vendorKeys);
  for (const edge of graph.edges) {
    // inherits_from: source is the child, target the parent.
    if (edge.relationType === "inherits_from" && vendorKeys.has(edge.targetKey)) {
      kept.add(edge.sourceKey);
    }
  }
  return {
    nodes: graph.nodes.filter((node) => kept.has(node.key)),
    edges: graph.edges.filter((edge) => kept.has(edge.sourceKey) && kept.has(edge.targetKey)),
    truncated: graph.truncated,
  };
}
