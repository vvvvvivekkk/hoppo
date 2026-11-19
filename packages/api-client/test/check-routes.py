#!/usr/bin/env python3
"""
Check that every path the API client can request is a route the API serves.

A mismatch here is invisible until runtime and then shows up as a 404 in one
screen, which is the worst way to find out. Comparing the two lists takes a
second and catches a renamed route the moment it happens.

Run with the API up:

    python3 packages/api-client/test/check-routes.py

Exits non-zero if any client path has no matching route.
"""
import json
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
ENDPOINTS = REPO / 'packages/api-client/src/endpoints.ts'
API_DOCS = 'http://localhost:4000/api/docs-json'

METHOD_FOR = {
    'get': 'GET', 'post': 'POST', 'patch': 'PATCH',
    'put': 'PUT', 'delete': 'DELETE', 'anonymousPost': 'POST',
}

# Matches client.<method>, then skips a balanced generic (which may nest one
# level, as in Paged<VerificationQueueItem>), then captures the literal path.
#
# An earlier version used <[^>]*> and silently skipped every call with a
# nested generic — reporting success without having checked three of them.
# Hence the explicit nesting, and the count assertion below.
CALL = re.compile(
    r"client\.(get|post|patch|put|delete|anonymousPost)\s*"
    r"(?:<(?:[^<>]|<[^<>]*>)*>)?\s*"
    r"\(\s*[`']([^`']+)[`']"
)


def client_paths() -> set[tuple[str, str]]:
    src = ENDPOINTS.read_text()
    found = CALL.findall(src)

    # Every wrapper in the file issues exactly one call, so the number of
    # matches should equal the number of `client.` occurrences. If it does not,
    # the regex is skipping something and the check is lying.
    expected = len(re.findall(r'\bclient\.(?:get|post|patch|put|delete|anonymousPost)\b', src))
    if len(found) != expected:
        print(
            f"ERROR: matched {len(found)} client calls but the file has {expected}. "
            "The extractor is missing some, so this check cannot be trusted.",
            file=sys.stderr,
        )
        sys.exit(2)

    out = set()
    for verb, path in found:
        path = re.sub(r'\$\{[^}]+\}', ':p', path)
        if not path.startswith('/'):
            path = '/' + path
        out.add((METHOD_FOR[verb], '/api/v1' + path))
    return out


def api_routes() -> set[tuple[str, str]]:
    """Read the routes from the OpenAPI document the API serves in dev."""
    with urllib.request.urlopen(API_DOCS, timeout=15) as response:
        doc = json.loads(response.read())

    out = set()
    for path, methods in doc.get('paths', {}).items():
        normalised = re.sub(r'\{[^}]+\}', ':p', path)
        for method in methods:
            out.add((method.upper(), normalised))
    return out


def main() -> int:
    try:
        routes = api_routes()
    except Exception as e:
        print(f"Could not read {API_DOCS}: {e}", file=sys.stderr)
        print("Start the API in development mode first (pnpm dev:api).", file=sys.stderr)
        return 2

    calls = client_paths()

    missing = sorted(f"  {m:6} {p}" for m, p in calls if (m, p) not in routes)

    print(f"client paths: {len(calls)}   api routes: {len(routes)}")

    if missing:
        print("\nClient paths with no matching API route:")
        print("\n".join(missing))
        return 1

    print("OK: every client path resolves to a route the API serves.")

    uncalled = sorted(f"  {m:6} {p}" for m, p in routes if (m, p) not in calls)
    print(f"\nRoutes the web consoles do not call ({len(uncalled)}):")
    print("\n".join(uncalled))
    return 0


if __name__ == '__main__':
    sys.exit(main())
