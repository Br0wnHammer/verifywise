import { matchesLaneFilter } from "../routing/laneFilter";
import type { SubmissionRouting } from "../types";

const lane = (l: "senior" | "standard") => ({ lane: l }) as SubmissionRouting;

describe("matchesLaneFilter", () => {
  const senior = { routingEnabled: true, routing: lane("senior"), laneReviewerIds: [1] };
  const standard = { routingEnabled: true, routing: lane("standard"), laneReviewerIds: [2, 1] };
  const unrouted = { routingEnabled: true, routing: null, laneReviewerIds: [] };

  it("filters by lane", () => {
    expect([senior, standard, unrouted].filter((r) => matchesLaneFilter(r, "all", 1))).toHaveLength(
      3,
    );
    expect(matchesLaneFilter(senior, "senior", 1)).toBe(true);
    expect(matchesLaneFilter(standard, "senior", 1)).toBe(false);
    expect(matchesLaneFilter(standard, "standard", 1)).toBe(true);
    expect(matchesLaneFilter(unrouted, "unrouted", 1)).toBe(true);
    expect(matchesLaneFilter(senior, "unrouted", 1)).toBe(false);
  });

  it("assigned to me means the user is in the assigned lane's reviewers", () => {
    expect(matchesLaneFilter(senior, "mine", 1)).toBe(true);
    expect(matchesLaneFilter(standard, "mine", 2)).toBe(true);
    expect(matchesLaneFilter(senior, "mine", 2)).toBe(false);
    expect(matchesLaneFilter(unrouted, "mine", 1)).toBe(false);
    expect(matchesLaneFilter(senior, "mine", null)).toBe(false);
  });

  it("keeps routing-off rows under All only", () => {
    const off = { routingEnabled: false, routing: lane("standard"), laneReviewerIds: [1] };
    const offUnrouted = { routingEnabled: false, routing: null, laneReviewerIds: [] };
    expect(matchesLaneFilter(off, "all", 1)).toBe(true);
    expect(matchesLaneFilter(off, "standard", 1)).toBe(false);
    expect(matchesLaneFilter(off, "mine", 1)).toBe(false);
    expect(matchesLaneFilter(offUnrouted, "unrouted", 1)).toBe(false);
  });
});
