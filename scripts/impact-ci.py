#!/usr/bin/env python3
"""Fetch the newest main impact-map artifact for `pnpm run test:impact`.

Task 6.17 step 4. The selector is pure and covered by `--self-test`. The fetch
mode reads `GH_TOKEN` or `GITHUB_TOKEN` and never prints it. A missing token, a
missing artifact, or an API error exits 0 and leaves the map absent, so the
selector falls back to the full run and says why.
"""

from __future__ import annotations

import io
import json
import os
import sys
import urllib.error
import urllib.request
import zipfile
from typing import Mapping, Sequence

ARTIFACT_NAME = "impact-map"
BRANCH = "main"
DEST = os.path.join(".cache", "impact", "impact-map.json")
MAX_BYTES = 64 * 1024 * 1024
MAX_PAGES = 5


def artifact_key(artifact: Mapping[str, object]) -> tuple[str, int]:
    created = artifact.get("created_at")
    ident = artifact.get("id")
    return (
        created if isinstance(created, str) else "",
        ident if isinstance(ident, int) else 0,
    )


def select_artifact(payload: object) -> Mapping[str, object] | None:
    """Newest non-expired `impact-map` whose workflow run landed on `main`."""
    if not isinstance(payload, Mapping):
        return None
    artifacts = payload.get("artifacts")
    if not isinstance(artifacts, list):
        return None
    best: Mapping[str, object] | None = None
    best_key: tuple[str, int] | None = None
    for artifact in artifacts:
        if not isinstance(artifact, Mapping):
            continue
        if artifact.get("name") != ARTIFACT_NAME or artifact.get("expired") is True:
            continue
        run = artifact.get("workflow_run")
        if not isinstance(run, Mapping) or run.get("head_branch") != BRANCH:
            continue
        key = artifact_key(artifact)
        if best is None or best_key is None or key > best_key:
            best = artifact
            best_key = key
    return best


def select_pages(pages: Sequence[object]) -> Mapping[str, object] | None:
    """Newest candidate across API pages. Pages may arrive in any order."""
    best: Mapping[str, object] | None = None
    best_key: tuple[str, int] | None = None
    for page in pages:
        chosen = select_artifact(page)
        if chosen is None:
            continue
        key = artifact_key(chosen)
        if best is None or best_key is None or key > best_key:
            best = chosen
            best_key = key
    return best


def next_link(header: str | None) -> str | None:
    if header is None:
        return None
    for part in header.split(","):
        url: str | None = None
        rel: str | None = None
        for piece in part.split(";"):
            item = piece.strip()
            if item.startswith("<") and item.endswith(">"):
                url = item[1:-1]
            elif item.startswith("rel="):
                rel = item[4:].strip().strip('"')
        if rel == "next" and url:
            return url
    return None


def choose_member(names: Sequence[str]) -> str | None:
    """The zip member that is the map. Rejects absolute paths and `..`."""
    good: list[str] = []
    for name in names:
        parts = name.replace("\\", "/").split("/")
        if parts[0] == "" or ".." in parts:
            continue
        if name.replace("\\", "/") == "impact-map.json" or name.replace("\\", "/").endswith(
            "/impact-map.json"
        ):
            good.append(name)
    if not good:
        return None
    good.sort(key=lambda member: (member.count("/"), member.count("\\"), len(member)))
    return good[0]


def _notice(text: str) -> int:
    print(f"impact-ci: {text}", file=sys.stderr)
    return 0


def _read_limited(response: object, limit: int) -> bytes:
    read = getattr(response, "read")
    chunks: list[bytes] = []
    total = 0
    while True:
        block = read(64 * 1024)
        if not isinstance(block, bytes):
            raise ValueError("response body is not bytes")
        if not block:
            break
        total += len(block)
        if total > limit:
            raise ValueError(f"response exceeds {limit} bytes")
        chunks.append(block)
    return b"".join(chunks)


def _api_json(
    url: str, token: str
) -> tuple[object, str | None]:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "stator-impact-ci",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = json.loads(_read_limited(response, MAX_BYTES).decode("utf-8"))
        header = response.headers.get("Link")
    return payload, next_link(header if isinstance(header, str) else None)


def _download(url: str, token: str) -> bytes:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "stator-impact-ci",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        return _read_limited(response, MAX_BYTES)


def extract_map(blob: bytes, dest: str) -> None:
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        member = choose_member(archive.namelist())
        if member is None:
            raise ValueError("artifact zip has no impact-map.json")
        info = archive.getinfo(member)
        if info.file_size > MAX_BYTES:
            raise ValueError("impact-map.json exceeds the size cap")
        payload = archive.read(member)
    parent = os.path.dirname(dest)
    if parent:
        os.makedirs(parent, exist_ok=True)
    temporary = f"{dest}.tmp"
    with open(temporary, "wb") as handle:
        handle.write(payload)
    os.replace(temporary, dest)


def fetch() -> int:
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    repo = os.environ.get("GITHUB_REPOSITORY")
    if not token or not repo or repo.count("/") != 1:
        return _notice("no token or GITHUB_REPOSITORY; leaving the map absent")
    api = os.environ.get("GITHUB_API_URL", "https://api.github.com").rstrip("/")
    url: str | None = f"{api}/repos/{repo}/actions/artifacts?name={ARTIFACT_NAME}&per_page=100"
    pages: list[object] = []
    try:
        for _ in range(MAX_PAGES):
            if url is None or not url.startswith(f"{api}/"):
                break
            payload, nxt = _api_json(url, token)
            pages.append(payload)
            if select_artifact(payload) is not None or nxt is None:
                break
            url = nxt
    except urllib.error.HTTPError as exc:
        return _notice(f"artifact list returned HTTP {exc.code}; leaving the map absent")
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError):
        return _notice("artifact list failed; leaving the map absent")
    chosen = select_pages(pages)
    if chosen is None:
        return _notice("no main impact-map artifact; pnpm run test:impact will fall back")
    download = chosen.get("archive_download_url")
    if not isinstance(download, str) or not download.startswith(f"{api}/"):
        return _notice("artifact has no archive URL; leaving the map absent")
    try:
        extract_map(_download(download, token), DEST)
    except urllib.error.HTTPError as exc:
        return _notice(f"artifact download returned HTTP {exc.code}; leaving the map absent")
    except (
        urllib.error.URLError,
        TimeoutError,
        ValueError,
        zipfile.BadZipFile,
        OSError,
    ):
        return _notice("artifact download failed; leaving the map absent")
    ident = chosen.get("id")
    print(f"impact-ci: wrote {DEST} from artifact {ident}")
    return 0


def _expect(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"impact-ci self-test failed: {message}")


def self_test() -> int:
    main_old = {
        "id": 1,
        "name": ARTIFACT_NAME,
        "expired": False,
        "created_at": "2026-10-01T00:00:00Z",
        "archive_download_url": "https://api.github.com/repos/o/r/actions/artifacts/1/zip",
        "workflow_run": {"head_branch": "main", "id": 10},
    }
    main_new = {**main_old, "id": 2, "created_at": "2026-10-02T00:00:00Z"}
    expired = {**main_new, "id": 3, "created_at": "2026-10-03T00:00:00Z", "expired": True}
    other = {
        **main_new,
        "id": 4,
        "created_at": "2026-10-04T00:00:00Z",
        "workflow_run": {"head_branch": "feature"},
    }
    chosen = select_artifact({"artifacts": [expired, other, main_old, main_new, {"name": "coverage"}]})
    _expect(chosen is not None and chosen.get("id") == 2, "newest main artifact")
    _expect(select_artifact({"artifacts": [expired, other]}) is None, "no usable artifact")
    _expect(select_artifact({}) is None, "missing artifacts list")
    _expect(select_artifact([]) is None, "payload is not an object")
    later_page = select_pages(
        [{"artifacts": [other, expired]}, {"artifacts": [main_old]}],
    )
    _expect(later_page is not None and later_page.get("id") == 1, "candidate on a later page")
    _expect(
        next_link('<https://api.github.com/a?page=2>; rel="next", <https://api.github.com/a?page=1>; rel="prev"')
        == "https://api.github.com/a?page=2",
        "next link",
    )
    _expect(next_link(None) is None, "absent link header")
    _expect(choose_member(["coverage-lcov", "nested/impact-map.json"]) == "nested/impact-map.json", "nested member")
    _expect(
        choose_member(["../impact-map.json", "/impact-map.json", "impact-map.json"]) == "impact-map.json",
        "rejects traversal",
    )
    _expect(choose_member(["../impact-map.json"]) is None, "traversal alone")
    blob = io.BytesIO()
    with zipfile.ZipFile(blob, "w") as archive:
        archive.writestr("dir/impact-map.json", b'{"schema":1}\n')
    extract_map(blob.getvalue(), os.path.join(".cache", "impact", "self-test-map.json"))
    with open(os.path.join(".cache", "impact", "self-test-map.json"), "rb") as handle:
        _expect(handle.read() == b'{"schema":1}\n', "extracted bytes")
    os.remove(os.path.join(".cache", "impact", "self-test-map.json"))
    print("impact-ci: self-test ok")
    return 0


def main(argv: Sequence[str]) -> int:
    if list(argv) == ["--self-test"]:
        return self_test()
    if argv:
        print("usage: impact-ci.py [--self-test]", file=sys.stderr)
        return 2
    return fetch()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
