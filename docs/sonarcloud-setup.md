# SonarCloud OSS setup (stator)

Maintainer guide for the SonarCloud analysis and the scanner configuration in
`sonar-project.properties`.

The analysis is not a workflow in this repository. `.github/workflows/pipeline.yml` calls
`pyrlyn/ci/.github/workflows/ci.yml@main`, and that workflow's `sonarcloud` job reads
`.github/infra.yml`. The check name is `pipeline / sonarcloud / sonarcloud`. Callers reference
pyrlyn/ci as `@main`; a SHA pin fails the shared `no-pinned-ci` check (plan-notes 361).

The `sonar.organization` / `sonar.projectKey` values (`listepo` / `listepo_stator`) are
**placeholders** until they match the SonarCloud UI after you import the project.
As of 2026-09-25 the public SonarCloud API reports no organization with the key
`listepo`, so the organization still has to be created (bound to the `listepo`
GitHub account) on first import.

## 1. Import the repository

1. Sign in at [sonarcloud.io](https://sonarcloud.io) with GitHub.
2. Create or pick the organization bound to the **listepo** GitHub account and choose
   the free plan for open-source (public) projects.
3. Import the **listepo/stator** repository.
4. Compare the **organization key** and **project key** shown in the UI with
   `sonar-project.properties`. If they differ, update the file so they match exactly;
   a mismatch makes the scan fail or report into the wrong project.

## 2. Turn Automatic Analysis off

This project is analyzed by CI (pyrlyn/ci's `sonarcloud` job runs
`SonarSource/sonarqube-scan-action`), so SonarCloud's **Automatic Analysis** must be
**off**. With both enabled, the CI scan fails with an error about Automatic Analysis
being enabled.

In the SonarCloud project: **Administration → Analysis Method → Automatic Analysis → off**.

## 3. Create a token

1. Open <https://sonarcloud.io/account/security>
   (**My Account → Security**, section **Access Tokens / Personal Tokens**).
2. Generate a token (for example `stator-github-actions`).
3. Copy the value; it is shown only once.

## 4. Add the `SONAR_TOKEN` secret

On **pyrlyn/stator**: **Settings → Secrets and variables → Actions → New repository secret**

- Name: `SONAR_TOKEN`
- Value: the token from step 3

Never commit the token. Fork pull requests do not receive it; what the job does then
is in section 5.

## 5. When the analysis runs

`pipeline.yml` starts on a pull request to `main` (`opened`, `synchronize`, `reopened`,
`ready_for_review`), on a push to `main`, on a Monday schedule, and on
**Actions → pipeline → Run workflow**. The SonarCloud job itself runs only for `push`,
`pull_request` and `workflow_dispatch` (pyrlyn/ci's default `sonarcloud.events`), so the
Monday schedule does not scan. A draft pull request skips every pipeline job, this one
included, until it is marked ready. Pull request decoration needs the SonarCloud GitHub
App, which the import in step 1 installs.

Without `SONAR_TOKEN` every step of the job skips with a notice and the check stays green.
A green run in that state does **not** mean an analysis happened.

## 6. Soft-fail for now, blocking later

Coverage and the scan use the shared workflow's `soft-fail` (default `true`): those two
steps are `continue-on-error`, and the Quality Gate is not awaited. The setup command is
not soft-fail. `pnpm run runtime` failing ends the job before coverage, and a failed job
cancels the rest of that pipeline run.

To make the analysis blocking once the dashboard looks sane:

1. Set `soft-fail: false` under `sonarcloud:` in `.github/infra.yml`.
2. Add `sonar.qualitygate.wait=true` to `sonar-project.properties` so the scan step
   fails when the Quality Gate fails.
3. Optionally mark `pipeline / sonarcloud / sonarcloud` as required in the branch
   protection rules for `main`.

## 7. Coverage

Coverage **is wired**: `coverage-command` is `pnpm run test:coverage` (vitest under c8,
which collects V8 coverage from the test workers and every CLI subprocess the tests spawn;
plan-notes 285), the same script the ci.yml `frontend (linux/x64)` job
(`frontend-coverage`, stage 1) runs. It writes `coverage/lcov.info`, which Sonar reads via
**`sonar.javascript.lcov.reportPaths`**. Before that, `setup-command` installs dependencies
and builds the runtime archive (`pnpm run runtime`), because a few unit tests compile and
run native binaries. A coverage failure is best effort while `soft-fail` is true, so the
scan still runs. A runtime failure is not.

Scope: the compiler (`packages/compiler/src`) is the analyzed source; `packages/tests` is
test code. Golden programs, the Test262 corpus, benchmark programs, differential-test
scratch and the FFI example consumer are excluded from analysis, as are the `site/` and
the vendored runtime dependencies (`packages/runtime/vendor/`, outside `sonar.sources`).

### C, C++ and Objective-C

SonarCloud's C-family analyzer needs a compilation database (`compile_commands.json`)
or build-wrapper output. This repository does not produce one in CI yet, so C, C++ and
Objective-C analysis is turned off in `sonar-project.properties` via
`sonar.c.file.suffixes=-`, `sonar.cpp.file.suffixes=-` and `sonar.objc.file.suffixes=-`.
Follow-up: generate `compile_commands.json` for the C runtime in `packages/runtime/src` (built with `just`/clang), set
`sonar.cfamily.compile-commands`, and remove those three lines.

The Zig memory core (`packages/runtime/src/*.zig`) is not a SonarCloud language.

## 8. Local dry run (optional)

Run the scanner locally only with `SONAR_TOKEN` exported in your shell; never write the
token into the repository.

## References

- Caller: `.github/workflows/pipeline.yml` (`pyrlyn/ci/.github/workflows/ci.yml@main`)
- Job config: `.github/infra.yml` (`sonarcloud`)
- Scanner configuration: `sonar-project.properties`
- Shared workflow: [pyrlyn/ci `docs/reusable-workflows.md`](https://github.com/pyrlyn/ci/blob/main/docs/reusable-workflows.md) (`sonarcloud.yml`)
- [SonarQube Cloud documentation](https://docs.sonarsource.com/sonarqube-cloud/)
