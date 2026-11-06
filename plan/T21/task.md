---
status: in progress
priority: P0
complexity: 2
readiness: 100%
agent:
---

# T21. Required status checks on `main` (cloud review)

The other cloud-review rows were struck without Steps and a Check because they needed no change.
T21 is a live GitHub-state change, so it gets both.

**Steps.**

1. Fix the `frontend-desktop` matrix in `.github/workflows/ci.yml`: a leading space in the JSON
   key (`" platform"`) left `matrix.platform` empty, so the Windows/macOS legs reported as
   `frontend (/x64)` / `frontend (/arm64)` — names no ruleset context can match. Trailing spaces
   in the `os` labels go in the same edit.
2. Update the `protect-main` ruleset (`pyrlyn/stator`, id 24341905) so
   `required_status_checks` is exactly: `pipeline / gate`, `static analysis`,
   `frontend (linux/x64)`, `frontend (windows/x64)`, `frontend (windows/arm64)`.
   (Apply via `gh api -X PUT repositories/1353641814/rulesets/24341905` — the `listepo/stator`
   alias 307-redirects and `gh` will not follow a redirected PUT.)
3. Leave `frontend (macos/arm64)` and the `-macos` twins **unrequired**: when the org variable
   `MACOS_CI_DISABLED` is true, the macOS matrix entry is removed (not skipped), so a required
   macOS context would block every PR with a check that never reports. The `if:`-gated
   `-macos` jobs report `skipped` (success for a required check) when the variable is true;
   the matrix-excluded desktop legs report nothing.
4. Do **not** reintroduce the `repo-settings` caller (#170/#171): it never had
   `REPO_ADMIN_TOKEN` and failed HTTP 401. Re-applying the ruleset after an accidental edit is
   the `gh api` PUT above, not a workflow.

**Check.**

```
gh api repos/pyrlyn/stator/rulesets/24341905 \
  --jq '[.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context]'
```

Must print exactly `["pipeline / gate","static analysis","frontend (linux/x64)","frontend (windows/x64)","frontend (windows/arm64)"]`, and a PR whose `static analysis` or a Windows `frontend` leg is red must show merge blocked (admin bypass remains available on PRs only — actor `RepositoryRole` admin, `bypass_mode: pull_request`).
