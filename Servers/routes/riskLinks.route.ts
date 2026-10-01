import express from "express";
const router = express.Router();

import authenticateJWT from "../middleware/auth.middleware";
import authorize from "../middleware/accessControl.middleware";
import {
  acknowledgeParentLevelChange,
  createRiskLink,
  getControlCoverage,
  getDismissalAnalytics,
  getDuplicateCandidates,
  getRiskGraph,
  getRiskLinks,
  getSharedProjects,
  recomputeAllRiskLinks,
  suggestRiskHierarchy,
  updateRiskLinkStatus,
} from "../controllers/riskLinks.ctrl";

// Declared before GET /:riskId is irrelevant (different verb), but kept first
// so the backfill route is the obvious one in this file.
router.post(
  "/recompute",
  authenticateJWT,
  authorize(["Admin", "SuperAdmin"]),
  recomputeAllRiskLinks,
);
router.post(
  "/suggest-hierarchy",
  authenticateJWT,
  authorize(["Admin", "SuperAdmin"]),
  suggestRiskHierarchy,
);

router.post("/", authenticateJWT, authorize(["Admin", "Editor"]), createRiskLink);
// Org-wide graph + dismissal analytics expose every link and raw dismiss notes;
// admin-only, matching the write/fan-out routes above.
router.get("/", authenticateJWT, authorize(["Admin", "SuperAdmin"]), getRiskGraph);
router.get(
  "/dismissals",
  authenticateJWT,
  authorize(["Admin", "SuperAdmin"]),
  getDismissalAnalytics,
);
// Declared before /:riskId: the param route would swallow /duplicates as a
// risk id. Org-wide report like the graph and dismissals above: admin-only.
router.get(
  "/duplicates",
  authenticateJWT,
  authorize(["Admin", "SuperAdmin"]),
  getDuplicateCandidates,
);
// Same param-route trap as /duplicates: /coverage must sit above /:riskId.
router.get("/coverage", authenticateJWT, authorize(["Admin", "SuperAdmin"]), getControlCoverage);
router.get("/:riskId", authenticateJWT, getRiskLinks);
router.get("/:riskId/shared-projects", authenticateJWT, getSharedProjects);
// Role matrix: Admin full, Editor write, Reviewer approve (status), Auditor
// read-only. Create and ack are writes (Admin/Editor); status transitions are
// approvals (Admin/Editor/Reviewer).
router.patch(
  "/:id",
  authenticateJWT,
  authorize(["Admin", "Editor", "Reviewer"]),
  updateRiskLinkStatus,
);
// Clearing a stale-inheritance warning the user has reviewed. Idempotent.
router.post(
  "/:id/acknowledge-parent-change",
  authenticateJWT,
  authorize(["Admin", "Editor"]),
  acknowledgeParentLevelChange,
);

export default router;
