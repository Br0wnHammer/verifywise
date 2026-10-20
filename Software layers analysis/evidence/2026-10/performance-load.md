# Performance & Load — Evidence Note 2026-10

**Layer:** Performance / Load
**Date written:** 2026-10-20
**Verification method:** `Test-Path` / `Get-ChildItem` against the working
tree of branch `chore/debora-one-fix-to-all`.

## Artifacts

| Artifact | Path | Status |
|----------|------|--------|
| k6 load-test suite | `Servers/tests/perf/` | 🟡 planned-this-cycle |
| Nightly perf CI workflow | `.github/workflows/perf-nightly.yml` | 🟡 planned-this-cycle |
| k6 perf baselines doc | `docs/deployment/k6-perf-baselines.md` | 🟡 planned-this-cycle |
| Multi-replica compose file | `docker-compose.multireplica.yml` | 🟡 planned-this-cycle |
| Multi-replica scaling doc | `docs/deployment/multi-replica-scaling.md` | 🟡 planned-this-cycle |
| Existing compose variants (context) | `docker-compose.yml`, `docker-compose.prod.yml`, `docker-compose.override.yml`, `docker-compose.observability.yml` | ✅ exists |

## Verification log

```
Test-Path Servers\tests\perf                      -> False  🟡
Test-Path .github\workflows\perf-nightly.yml      -> False  🟡
Test-Path docs\deployment\k6-perf-baselines.md    -> False  🟡
Test-Path docker-compose.multireplica.yml         -> False  🟡
Test-Path docs\deployment\multi-replica-scaling.md -> False 🟡
Get-ChildItem Servers\tests -Recurse -Filter *perf* -> (no matches) 🟡
```

Root directory currently ships four compose files (listed above, ✅); none
of them is the multi-replica variant.

## Notes

- All five performance artifacts were **absent on disk** when this note was
  written. They are scheduled to land in this cycle; each must be re-verified
  with `Test-Path` before this note (or its successor) may cite them as ✅.
- Until at least `Servers/tests/perf/` and `perf-nightly.yml` exist and have
  at least one recorded run, the benchmark's performance layer must be
  reported as **not yet evidenced** — do not infer a score.
- Backend health endpoints that the k6 suite and monitors will target are
  already in place: `Servers/app.ts` (`/health`, `/health/live`,
  `/health/ready`, lines 258–267) — ✅ verified by content search.
