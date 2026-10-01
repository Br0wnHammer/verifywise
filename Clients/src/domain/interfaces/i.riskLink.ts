export type RiskLinkStatus = "suggested" | "confirmed" | "dismissed";
export type RiskLinkSource = "derived" | "user" | "agent";
export type RiskLinkRelationType = "related_to" | "inherits_from";
export type RiskLinkDirection = "outgoing" | "incoming" | "undirected";

/** Mirrors `ParentEntityType` in Servers/services/riskLinks/hierarchy.ts. */
export type RiskLinkEntityType = "risk" | "model_risk" | "vendor_risk";

/** Empty for "risk": a project risk in a panel of project risks needs no label. */
export const ENTITY_TYPE_LABELS: Record<RiskLinkEntityType, string> = {
  risk: "",
  model_risk: "Model risk",
  vendor_risk: "Vendor risk",
};

/** Mirrors `DismissReason` in Servers/services/riskLinks/dismissReason.ts. */
export type DismissReason =
  | "not_related"
  | "too_weak"
  | "duplicate"
  | "wrong_direction"
  | "wrong_parent"
  | "not_hierarchical"
  | "other";

export interface RiskLinkReason {
  signal: string;
  weight: number;
  detail?: string;
}

/** Mirrors `toResponse` in Servers/controllers/riskLinks.ctrl.ts. */
export interface RiskLink {
  id: number;
  status: RiskLinkStatus;
  source: RiskLinkSource;
  relationType: RiskLinkRelationType;
  score: number;
  reasons: RiskLinkReason[];
  direction: RiskLinkDirection;
  decidedAt: string | null;
  lastComputedAt: string | null;
  /** Set only on a link dismissed from `suggested`, and only if the user said why. */
  dismissReason: DismissReason | null;
  dismissNote: string | null;
  parentLevelChangedAt: string | null;
  relatedRisk: {
    id: number;
    entityType: RiskLinkEntityType;
    name: string | null;
    riskLevel: string | null;
    ownerId: number | null;
  };
}

/**
 * For `inherits_from`, `sourceRiskId` is the risk that inherits. The client never
 * canonicalises — the server does, and only for `related_to`.
 */
export type CreateRiskLinkInput = {
  sourceRiskId: number;
  relationType: RiskLinkRelationType;
} & (
  | { targetRiskId: number }
  | { targetModelRiskId: number }
  | { targetVendorRiskId: number }
);

/**
 * A cross-entity parent candidate that shares at least one project with the
 * risk being linked. Ranking only — the picker still lists non-sharers.
 */
export interface SharedProjectCandidate {
  entityType: Exclude<RiskLinkEntityType, "risk">;
  id: number;
  projects: string[];
}

/** `${entityType}:${id}` — stable across the three risk tables, which share an id space. */
export type RiskGraphNodeKey = string;

export interface RiskGraphNode {
  key: RiskGraphNodeKey;
  entityType: RiskLinkEntityType;
  id: number;
  name: string | null;
  riskLevel: string | null;
}

/** Mirrors `getRiskGraph` in Servers/controllers/riskLinks.ctrl.ts. */
export interface RiskGraphEdge {
  id: number;
  /** For `inherits_from` this is the CHILD. Always a project risk. */
  sourceKey: RiskGraphNodeKey;
  /** For `inherits_from` this is the PARENT. */
  targetKey: RiskGraphNodeKey;
  relationType: RiskLinkRelationType;
  status: Exclude<RiskLinkStatus, "dismissed">;
  score: number;
  parentLevelChangedAt: string | null;
}

export interface RiskGraph {
  nodes: RiskGraphNode[];
  edges: RiskGraphEdge[];
  /** True when the org has more edges than the server will return. */
  truncated: boolean;
}

export interface DismissalSignalRow {
  signal: string;
  decided: number;
  dismissed: number;
  /** "none" when most dismissals of this signal gave no reason. */
  topReason: string | null;
}

export interface DismissalReasonRow {
  relationType: RiskLinkRelationType;
  source: RiskLinkSource;
  status: "confirmed" | "dismissed";
  /** Null is a legitimate value: dismissed without giving a reason. */
  dismissReason: DismissReason | null;
  count: number;
}

export interface DismissalNote {
  id: number;
  relationType: RiskLinkRelationType;
  source: RiskLinkSource;
  dismissReason: DismissReason | null;
  dismissNote: string;
  decidedAt: string | null;
  sourceName: string | null;
}

export interface DismissalAnalytics {
  signals: DismissalSignalRow[];
  reasons: DismissalReasonRow[];
  notes: DismissalNote[];
}

/**
 * F7 — duplicate candidates, and F8 — control coverage.
 *
 * Snake_case on purpose: unlike the dismissal payload, which the query layer
 * maps to camelCase, these two services return their own interfaces verbatim
 * (Servers/services/riskLinks/duplicates.ts, coverage.ts). Renaming here would
 * mean a translation layer that only exists to hide what the API sends.
 */
export interface DuplicateCandidate {
  risk_a: { id: number; risk_name: string; risk_owner: number | null };
  risk_b: { id: number; risk_name: string; risk_owner: number | null };
  /** Jaccard over name+description tokens, rounded to 2 decimals. */
  similarity: number;
  shared_tokens: string[];
  /** Display context, e.g. "category: Operational risk", "project". */
  also_shares: string[];
}

export interface DuplicateReport {
  organization_id: number;
  scanned: number;
  compared: number;
  /** Pairs above the threshold; `candidates` keeps only the closest of them. */
  matched: number;
  /** The scan stopped early (risks read or pairs scored hit a cap), so it is a sample. */
  truncated: boolean;
  candidates: DuplicateCandidate[];
}

export interface CoverageGapRisk {
  id: number;
  risk_name: string;
  risk_owner: number | null;
  risk_level: string | null;
  mitigation_status: string | null;
  projects: { id: number; name: string; has_framework: boolean }[];
  /**
   * Context only. A risk linked solely to a questionnaire answer is still an
   * audit finding, so this never moves a risk out of `gaps`.
   */
  assessment_link_count: number;
}

export interface CoverageReport {
  summary: {
    total_active_risks: number;
    covered: number;
    gap: number;
    no_framework: number;
  };
  /** Has a framework-attached project but no control link — a real finding. */
  gaps: CoverageGapRisk[];
  /** Nothing to map to yet. Not a finding. */
  no_framework: CoverageGapRisk[];
  truncated: boolean;
}
