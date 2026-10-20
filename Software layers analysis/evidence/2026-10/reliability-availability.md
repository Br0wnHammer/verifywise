# Reliability & Availability — Evidence Note 2026-10

**Layer:** Reliability / Availability
**Date written:** 2026-10-20
**Verification method:** `Test-Path` / `Get-ChildItem` / `Select-String`
against the working tree of branch `chore/debora-one-fix-to-all`.

## Artifacts

| Artifact | Path | Status |
|----------|------|--------|
| Backend health routes | `Servers/app.ts` (`/health`, `/health/live`, `/health/ready`, lines 254–267) | ✅ exists |
| Playwright canary specs | `Clients/e2e/canary/` | ✅ exists |
| Canary CI workflow | `.github/workflows/canary.yml` | 🟡 planned-this-cycle |
| Restore-test CI workflow | `.github/workflows/restore-test.yml` | 🟡 planned-this-cycle |
| Disaster recovery guide | `docs/deployment/DISASTER_RECOVERY_GUIDE.md` | ✅ exists |

## Verification log

```
Test-Path Servers\app.ts                              -> True   ✅ (/health, /health/live, /health/ready
                                                                 confirmed via Select-String, lines 254–267)
Get-ChildItem Clients\e2e\canary -Recurse -File       -> 2 files ✅
    - canary.spec.ts
    - csp-capture.spec.ts
Test-Path .github\workflows\canary.yml                -> False  🟡
Test-Path .github\workflows\restore-test.yml          -> False  🟡
Test-Path docs\deployment\DISASTER_RECOVERY_GUIDE.md  -> True   ✅ (32,184 bytes)
```

Existing workflows in `.github/workflows/` (for context, ✅):
`backend-checks.yml`, `frontend-checks.yml`, `e2e-tests.yml`,
`aigateway-checks.yml`, `codeql.yml`, `deploy-to-production.yml`,
`docker-image.yml`, `semgrep.yml`, `zap-*`, and others — **no** `canary.yml`
or `restore-test.yml` yet.

## Notes

- The canary **specs** exist on disk but have **no CI runner yet** — they are
  not executed anywhere until `canary.yml` lands. Availability claims for the
  frontend canary must stay 🟡 until the workflow has a recorded run.
- `docs/deployment/` currently contains: `README.md`,
  `CONFIGURATION_REFERENCE.md`, `DISASTER_RECOVERY_GUIDE.md` ✅,
  `PRODUCTION_DEPLOYMENT_GUIDE.md`, `SECURITY_HARDENING_GUIDE.md`.
- Companion monitoring doc: `docs/deployment/uptime-monitoring.md`
  (Uptime Kuma checks against `/health`) — written this cycle.
