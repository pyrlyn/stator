#!/usr/bin/env python3
"""Place the main-branch test impact map where `pnpm run test:impact` reads it.

Plan.md §9 Task 6.17 step 4: main and the nightly upload `.cache/impact/impact-map.json`
as an Actions artifact named `impact-map`. A pull request downloads the newest one whose
workflow run is on `main`. When none exists yet, `ensure` records a map at the pull
request's base commit (that commit is `main`) so the selector can still name a selection.
The selector itself, not this script, falls back to the full run when the map it was
given is unusable.

Commands:
  self-test                         pure checks, no network
  fetch                             download the newest main artifact, or exit 2
  record-base <40-hex-sha>          record a clean map at that commit
  ensure <40-hex-sha>               fetch, or record-base when fetch exits 2
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Mapping, Sequence

ARTIFACT_NAME = "impact-map"
MAP_NAME = "impact-map.json"
NO_ARTIFACT = 2


class NoArtifact(Exception):
    """Main has not published an impact-map artifact."""


def choose_artifact(artifacts: Sequence[Mapping[str, object]]) -> Mapping[str, object] | None:
    """Newest non-expired `impact-map` whose workflow run is on `main`."""
    chosen: Mapping[str, object] | None = None
    chosen_at = ""
    for item in artifacts:
        if item.get("name") != ARTIFACT_NAME or item.get("expired") is True:
            continue
        run = item.get("workflow_run")
        if not isinstance(run, Mapping) or run.get("head_branch") != "main":
            continue
        created = item.get("created_at")
        created_at = created if isinstance(created, str) else ""
        if chosen is None or created_at > chosen_at:
            chosen = item
            chosen_at = created_at
    return chosen


def workspace_root() -> Path:
    override = os.environ.get("GITHUB_WORKSPACE")
    if override:
        return Path(override)
    out = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True)
    return Path(out.strip())


def map_path(root: Path) -> Path:
    return root / ".cache" / "impact" / MAP_NAME


def announce(path: Path, source: str) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit("impact: map is not a JSON object")
    commit = data.get("commit")
    if not isinstance(commit, str) or len(commit) < 12:
        raise SystemExit("impact: map has no commit")
    line = (
        f"impact: map commit {commit} node {data.get('node')} "
        f"platform {data.get('platform')} dirty {data.get('dirty')} — {source}"
    )
    print(line, flush=True)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")


def gh_json(endpoint: str) -> object:
    raw = subprocess.check_output(["gh", "api", endpoint], text=True)
    return json.loads(raw)


def list_artifacts(repo: str) -> list[Mapping[str, object]]:
    found: list[Mapping[str, object]] = []
    for page in range(1, 11):
        payload = gh_json(
            f"repos/{repo}/actions/artifacts?name={ARTIFACT_NAME}&per_page=100&page={page}"
        )
        if not isinstance(payload, dict):
            raise SystemExit("impact: artifact list was not a JSON object")
        batch = payload.get("artifacts")
        if not isinstance(batch, list):
            raise SystemExit("impact: artifact list has no artifacts array")
        for item in batch:
            if isinstance(item, dict):
                found.append(item)
        if len(batch) < 100:
            break
    return found


def member_name(names: Sequence[str]) -> str:
    exact = [name for name in names if name == MAP_NAME or name.endswith("/" + MAP_NAME)]
    if len(exact) != 1:
        raise SystemExit(f"impact: artifact zip has {len(exact)} {MAP_NAME} entries")
    name = exact[0]
    if name.startswith("/") or ".." in Path(name).parts:
        raise SystemExit("impact: artifact zip entry escapes the archive")
    return name


def fetch(root: Path | None = None) -> None:
    repo = os.environ.get("GITHUB_REPOSITORY") or os.environ.get("GH_REPO")
    if not repo:
        raise SystemExit("impact: GITHUB_REPOSITORY is not set")
    if not os.environ.get("GH_TOKEN") and not os.environ.get("GITHUB_TOKEN"):
        raise SystemExit("impact: GH_TOKEN is not set")
    chosen = choose_artifact(list_artifacts(repo))
    if chosen is None:
        raise NoArtifact()
    artifact_id = chosen.get("id")
    if not isinstance(artifact_id, int):
        raise SystemExit("impact: artifact id is not an integer")
    root = root or workspace_root()
    dest = map_path(root)
    dest.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="stator-impact-zip-") as tmp:
        zip_path = Path(tmp) / "artifact.zip"
        with zip_path.open("wb") as handle:
            subprocess.run(
                ["gh", "api", f"repos/{repo}/actions/artifacts/{artifact_id}/zip"],
                stdout=handle,
                check=True,
            )
        with zipfile.ZipFile(zip_path) as archive:
            info = archive.getinfo(member_name(archive.namelist()))
            with archive.open(info) as src, dest.open("wb") as out:
                shutil.copyfileobj(src, out)
    run = chosen.get("workflow_run")
    run_id = run.get("id") if isinstance(run, Mapping) else "?"
    announce(dest, f"downloaded main artifact {artifact_id} from run {run_id}")


def require_sha(sha: str) -> str:
    if len(sha) != 40 or any(ch not in "0123456789abcdefABCDEF" for ch in sha):
        raise SystemExit("impact: base sha must be 40 hex characters")
    return sha


def record_base(sha: str, root: Path | None = None) -> None:
    base = require_sha(sha)
    root = root or workspace_root()
    subprocess.run(["git", "cat-file", "-e", f"{base}^{{commit}}"], cwd=root, check=True)
    parent = Path(tempfile.mkdtemp(prefix="stator-impact-base-"))
    work = parent / "tree"
    try:
        subprocess.run(
            ["git", "worktree", "add", "--detach", str(work), base],
            cwd=root,
            check=True,
        )
        subprocess.run(["pnpm", "install", "--frozen-lockfile"], cwd=work, check=True)
        subprocess.run(["pnpm", "run", "test:impact:record"], cwd=work, check=True)
        src = map_path(work)
        if not src.is_file():
            raise SystemExit("impact: record finished without a map")
        dest = map_path(root)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest)
        announce(dest, "recorded at the pull request base (main has no impact-map artifact yet)")
    finally:
        subprocess.run(
            ["git", "worktree", "remove", "--force", str(work)],
            cwd=root,
            check=False,
        )
        shutil.rmtree(parent, ignore_errors=True)


def ensure(sha: str) -> None:
    try:
        fetch()
    except NoArtifact:
        print("impact: no main impact-map artifact", flush=True)
        record_base(sha)


def self_test() -> None:
    main_new: Mapping[str, object] = {
        "name": ARTIFACT_NAME,
        "expired": False,
        "created_at": "2026-10-19T00:00:00Z",
        "id": 2,
        "workflow_run": {"head_branch": "main", "id": 20},
    }
    main_old: Mapping[str, object] = {
        "name": ARTIFACT_NAME,
        "expired": False,
        "created_at": "2026-10-18T00:00:00Z",
        "id": 1,
        "workflow_run": {"head_branch": "main", "id": 10},
    }
    expired: Mapping[str, object] = {
        "name": ARTIFACT_NAME,
        "expired": True,
        "created_at": "2026-10-20T00:00:00Z",
        "id": 3,
        "workflow_run": {"head_branch": "main", "id": 30},
    }
    other: Mapping[str, object] = {
        "name": ARTIFACT_NAME,
        "expired": False,
        "created_at": "2026-10-21T00:00:00Z",
        "id": 4,
        "workflow_run": {"head_branch": "feature", "id": 40},
    }
    nameless: Mapping[str, object] = {"name": ARTIFACT_NAME, "expired": False, "id": 5}
    chosen = choose_artifact([expired, other, main_old, nameless, main_new])
    if chosen is None or chosen.get("id") != 2:
        raise SystemExit("impact: self-test did not pick the newest main artifact")
    if choose_artifact([expired, other, nameless]) is not None:
        raise SystemExit("impact: self-test accepted an unusable artifact")
    if choose_artifact([]) is not None:
        raise SystemExit("impact: self-test accepted an empty list")
    if member_name([".cache/impact/impact-map.json"]) != ".cache/impact/impact-map.json":
        raise SystemExit("impact: self-test rejected the recorded path")
    if member_name(["impact-map.json"]) != "impact-map.json":
        raise SystemExit("impact: self-test rejected a basename entry")
    try:
        member_name(["../impact-map.json"])
    except SystemExit:
        pass
    else:
        raise SystemExit("impact: self-test allowed a path escape")
    try:
        member_name(["a/impact-map.json", "b/impact-map.json"])
    except SystemExit:
        pass
    else:
        raise SystemExit("impact: self-test allowed two map entries")
    print("impact: self-test ok", flush=True)


def main(argv: Sequence[str]) -> None:
    if len(argv) == 1 and argv[0] == "self-test":
        self_test()
        return
    if len(argv) == 1 and argv[0] == "fetch":
        try:
            fetch()
        except NoArtifact:
            print("impact: no main impact-map artifact", flush=True)
            raise SystemExit(NO_ARTIFACT) from None
        return
    if len(argv) == 2 and argv[0] == "record-base":
        record_base(argv[1])
        return
    if len(argv) == 2 and argv[0] == "ensure":
        ensure(argv[1])
        return
    raise SystemExit(
        "usage: impact_map.py self-test | fetch | record-base <sha> | ensure <sha>"
    )


if __name__ == "__main__":
    main(sys.argv[1:])
