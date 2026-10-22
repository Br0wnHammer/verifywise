import type { SubmissionRouting } from "../types";

export type LaneFilter = "all" | "senior" | "standard" | "unrouted" | "mine";

export const LANE_FILTER_ITEMS: Array<{ _id: LaneFilter; name: string }> = [
  { _id: "all", name: "All" },
  { _id: "senior", name: "Senior" },
  { _id: "standard", name: "Standard" },
  { _id: "unrouted", name: "Not routed" },
  { _id: "mine", name: "Assigned to me" },
];

interface LaneRow {
  routing?: SubmissionRouting | null;
  laneReviewerIds?: number[];
}

/** Whether a list row passes the lane filter; "mine" = the user can decide its assigned lane. */
export function matchesLaneFilter(
  row: LaneRow,
  filter: LaneFilter,
  userId: number | null,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "senior":
    case "standard":
      return row.routing?.lane === filter;
    case "unrouted":
      return !row.routing;
    case "mine":
      return userId !== null && !!row.laneReviewerIds?.includes(userId);
  }
}
