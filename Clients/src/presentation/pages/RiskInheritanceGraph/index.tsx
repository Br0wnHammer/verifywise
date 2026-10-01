/**
 * @fileoverview Risk Inheritance Graph page.
 *
 * Visual explorer for risk_links: nodes are risks, edges are inherits_from and
 * related_to. Positions come from the deterministic layout in ./layout —
 * nothing here force-simulates.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  BackgroundVariant,
  Panel,
  ReactFlowProvider,
  MarkerType,
  type OnSelectionChangeParams,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Alert, Box, Typography, Stack, CircularProgress, useTheme } from "@mui/material";
import { Network, AlertTriangle } from "lucide-react";
import { EmptyState } from "../../components/EmptyState";
import { getRiskGraph } from "../../../application/repository/riskLink.repository";
import { useIsAdmin } from "../../../application/hooks/useIsAdmin";
import { useTranslation } from "../../../application/hooks/useTranslation";
import { APIError } from "../../../application/tools/error";
import type { RiskGraph } from "../../../domain/interfaces/i.riskLink";
import RiskNode from "./RiskNode";
import GraphGuide from "./GraphGuide";
import type { RiskInheritanceNodeData } from "./types";
import DismissalAnalytics from "./DismissalAnalytics";
import DuplicateCandidates from "./DuplicateCandidates";
import ControlCoverage from "./ControlCoverage";
import { ENTITY_TYPE_COLORS, EDGE_LABELS } from "./types";
import { layoutRiskGraph } from "./layout";
import { fill } from "../../../i18n/fill";
import {
  graphWrapperSx,
  pageContainerSx,
  graphContainerStyle,
  loadingContainerSx,
  loadingTextSx,
  errorContainerSx,
  errorTextSx,
  controlPanelSx,
  legendLabelSx,
  legendItemSx,
  legendTextSx,
  statsContainerSx,
  statsTextSx,
} from "./styles";

// Register custom node types
const nodeTypes = { riskNode: RiskNode };

// Drops the "React Flow" corner badge; the library is MIT, so hiding it is allowed.
const proOptions = { hideAttribution: true };

// Legend rows: line swatch + real text (never a background image). Style and
// opacity mirror the edges themselves below, which take their stroke from
// theme.palette.text.secondary — a swatch with its own colour would misdescribe them.
const LEGEND: { label: string; dashed: boolean; opacity: number }[] = [
  { label: EDGE_LABELS.inherits, dashed: false, opacity: 1 },
  { label: EDGE_LABELS.suggested, dashed: true, opacity: 0.6 },
  { label: EDGE_LABELS.competing, dashed: true, opacity: 0.35 },
  { label: EDGE_LABELS.related, dashed: true, opacity: 0.8 },
];

/**
 * Selecting a risk is the only way 221 links stay readable: everything that is
 * not on a path to the selected risk recedes, and only then are edge labels
 * worth drawing. With nothing selected the legend carries the line vocabulary,
 * so the labels are pure noise and stay off.
 */
/** theme.palette action-disabled level — the one receded opacity the design system fixes. */
const DIMMED_NODE_OPACITY = 0.38;
/** Edges need to go further than nodes: 221 faint lines still read as a wash. */
const DIMMED_EDGE_OPACITY = 0.08;

const RiskInheritanceGraphInner: React.FC = () => {
  const theme = useTheme();
  const { t } = useTranslation();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [graph, setGraph] = useState<RiskGraph | null>(null);
  const [showTruncated, setShowTruncated] = useState(true);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  // ReactFlow owns selection, so clicking a node, clicking the canvas and
  // pressing Enter on a focused node all land here for free.
  const handleSelectionChange = useCallback(({ nodes: selected }: OnSelectionChangeParams) => {
    setSelectedKey(selected.length === 1 ? selected[0].id : null);
  }, []);

  useEffect(() => {
    let mounted = true;
    const loadData = async () => {
      try {
        setLoading(true);
        setError(null);
        const data = await getRiskGraph();
        if (mounted) setGraph(data);
      } catch (err) {
        if (mounted) {
          setError(err instanceof APIError ? err.message : "Failed to load the risk graph");
        }
      } finally {
        if (mounted) setLoading(false);
      }
    };
    loadData();
    return () => {
      mounted = false;
    };
  }, []);

  const layout = useMemo(() => (graph ? layoutRiskGraph(graph) : null), [graph]);

  // A node is stale when any inherits_from edge pointing at it (as the child)
  // carries Feature 2's flag.
  const staleByNode = useMemo(() => {
    const stale = new Map<string, string>();
    for (const edge of graph?.edges ?? []) {
      if (edge.relationType === "inherits_from" && edge.parentLevelChangedAt) {
        stale.set(edge.sourceKey, edge.parentLevelChangedAt);
      }
    }
    return stale;
  }, [graph]);

  useEffect(() => {
    if (!graph || !layout) return;

    setNodes(
      graph.nodes.map((node) => ({
        id: node.key,
        type: "riskNode",
        position: layout.positions.get(node.key) ?? { x: 0, y: 0 },
        data: {
          name: node.name ?? fill(t("Risk {id}"), { id: node.id }),
          entityType: node.entityType,
          riskLevel: node.riskLevel,
          staleSince: staleByNode.get(node.key) ?? null,
        } as RiskInheritanceNodeData,
      })),
    );

    const stroke = theme.palette.text.secondary;
    setEdges(
      graph.edges.map((edge) => {
        if (edge.relationType === "related_to") {
          return {
            id: String(edge.id),
            source: edge.sourceKey,
            target: edge.targetKey,
            data: { label: EDGE_LABELS.related },
            labelStyle: { fontSize: 9, fill: theme.palette.text.secondary },
            labelBgStyle: { fill: theme.palette.background.main, fillOpacity: 0.9 },
            style: { stroke, strokeWidth: 1, strokeDasharray: "5 5", opacity: 0.8 },
          };
        }
        // The ReactFlow source is the PARENT and the target is the CHILD — the
        // opposite of the DB row, where source_risk_id is the child — so the
        // arrow points down at the child: "this parent covers this child".
        const demoted = layout.demotedEdgeIds.has(edge.id);
        const suggested = edge.status === "suggested";
        return {
          id: String(edge.id),
          source: edge.targetKey,
          target: edge.sourceKey,
          data: {
            label: demoted
              ? EDGE_LABELS.competing
              : suggested
                ? EDGE_LABELS.suggested
                : EDGE_LABELS.inherits,
          },
          labelStyle: { fontSize: 9, fill: theme.palette.text.secondary },
          labelBgStyle: { fill: theme.palette.background.main, fillOpacity: 0.9 },
          markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
          style: {
            stroke,
            strokeWidth: demoted ? 1 : 2,
            ...(suggested || demoted ? { strokeDasharray: "5 5" } : {}),
            opacity: demoted ? 0.35 : suggested ? 0.6 : 1,
          },
        };
      }),
    );
  }, [graph, layout, staleByNode, setNodes, setEdges, theme, t]);

  const { displayNodes, displayEdges } = useMemo(() => {
    if (!selectedKey) return { displayNodes: nodes, displayEdges: edges };

    const onPath = new Set<string>([selectedKey]);
    const touching = new Set<string>();
    for (const edge of edges) {
      if (edge.source !== selectedKey && edge.target !== selectedKey) continue;
      touching.add(edge.id);
      onPath.add(edge.source);
      onPath.add(edge.target);
    }

    return {
      displayNodes: nodes.map((node) => ({
        ...node,
        style: {
          ...node.style,
          opacity: onPath.has(node.id) ? 1 : DIMMED_NODE_OPACITY,
          transition: "opacity 0.2s ease",
        },
      })),
      displayEdges: edges.map((edge) =>
        touching.has(edge.id)
          ? {
              ...edge,
              label: (edge.data as { label?: string } | undefined)?.label,
              style: { ...edge.style, opacity: 1 },
              zIndex: 1,
            }
          : { ...edge, style: { ...edge.style, opacity: DIMMED_EDGE_OPACITY } },
      ),
    };
  }, [nodes, edges, selectedKey]);

  let graphArea: React.ReactNode;
  if (loading) {
    graphArea = (
      <Box sx={loadingContainerSx}>
        <CircularProgress size={40} sx={{ color: theme.palette.primary.main }} />
        <Typography sx={loadingTextSx}>Loading risk inheritance graph...</Typography>
      </Box>
    );
  } else if (error) {
    graphArea = (
      <Box sx={errorContainerSx}>
        <AlertTriangle size={20} color={theme.palette.status.error.main} />
        <Typography sx={errorTextSx}>{error}</Typography>
      </Box>
    );
  } else if (!graph || graph.nodes.length === 0) {
    graphArea = (
      <EmptyState
        icon={Network}
        message="No risk links yet. Run the link scan from a risk's Linked risks panel."
        fillContainer
      />
    );
  } else {
    graphArea = (
      <>
        {graph.truncated && showTruncated && (
          <Alert severity="info" onClose={() => setShowTruncated(false)}>
            Showing the first 500 links. Filter by status to narrow the graph.
          </Alert>
        )}
        <Box sx={graphWrapperSx} aria-label="Risk inheritance graph">
          <div style={graphContainerStyle}>
            <ReactFlow
              nodes={displayNodes}
              edges={displayEdges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onSelectionChange={handleSelectionChange}
              nodeTypes={nodeTypes}
              proOptions={proOptions}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              minZoom={0.1}
              maxZoom={2}
              defaultEdgeOptions={{ type: "smoothstep" }}
            >
              <Controls showInteractive={false} />
              <MiniMap
                nodeColor={(n) =>
                  ENTITY_TYPE_COLORS[(n.data as RiskInheritanceNodeData)?.entityType ?? "risk"]
                }
                maskColor="rgba(0,0,0,0.1)"
              />
              <Background
                variant={BackgroundVariant.Dots}
                gap={20}
                size={1}
                color={theme.palette.divider}
              />

              <Panel position="top-left">
                <Stack sx={controlPanelSx}>
                  <Typography sx={legendLabelSx}>Link types</Typography>
                  {LEGEND.map((entry) => (
                    <Box key={entry.label} sx={legendItemSx}>
                      <Box
                        sx={{
                          width: 28,
                          borderTop: `2px ${entry.dashed ? "dashed" : "solid"} ${
                            theme.palette.text.secondary
                          }`,
                          opacity: entry.opacity,
                        }}
                        aria-hidden="true"
                      />
                      <Typography sx={legendTextSx}>{entry.label}</Typography>
                    </Box>
                  ))}
                  <Box sx={statsContainerSx}>
                    <Typography sx={statsTextSx}>
                      {fill(t("{risks} risks, {links} links"), {
                        risks: nodes.length,
                        links: edges.length,
                      })}
                    </Typography>
                    <Typography sx={statsTextSx}>
                      {selectedKey
                        ? "Click the canvas to clear the selection."
                        : "Select a risk to trace its links."}
                    </Typography>
                  </Box>
                </Stack>
              </Panel>

              <Panel position="top-right">
                <GraphGuide />
              </Panel>
            </ReactFlow>
          </div>
        </Box>
      </>
    );
  }

  return (
    <Box sx={pageContainerSx}>
      {graphArea}
      <DismissalAnalytics />
      <DuplicateCandidates />
      <ControlCoverage />
    </Box>
  );
};

const RiskInheritanceGraph: React.FC = () => {
  const isAdmin = useIsAdmin();
  if (!isAdmin) {
    return (
      <Box sx={pageContainerSx}>
        <EmptyState
          icon={Network}
          message="Only admins can view the risk inheritance graph."
          showBorder={false}
        />
      </Box>
    );
  }
  return (
    <ReactFlowProvider>
      <RiskInheritanceGraphInner />
    </ReactFlowProvider>
  );
};

export default RiskInheritanceGraph;
