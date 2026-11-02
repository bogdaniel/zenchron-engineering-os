#!/usr/bin/env python3
"""Check source file line-count policy from AGENTS.md."""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_SUFFIXES = {".go", ".py", ".js", ".jsx", ".ts", ".tsx", ".css", ".html", ".yml", ".yaml"}
EXCLUDED_PARTS = {".git", "node_modules", "dist", "vendor", "coverage", "playwright-report", "test-results"}


def git_paths() -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    return [ROOT / path.decode() for path in result.stdout.split(b"\0") if path]


def exceptions() -> set[str]:
    file = ROOT / "file-size-exceptions.tsv"
    if not file.exists():
        return set()
    entries: set[str] = set()
    for number, line in enumerate(file.read_text().splitlines(), 1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        fields = line.split("\t")
        if len(fields) != 2 or not fields[0] or not fields[1].strip() or fields[0] in entries:
            raise ValueError(f"{file.name}:{number}: expected unique path<TAB>reason")
        if fields[0] not in {str(path.relative_to(ROOT)) for path in git_paths()}:
            raise ValueError(f"{file.name}:{number}: stale or untracked path {fields[0]}")
        entries.add(fields[0])
    return entries


def main() -> int:
    failed = False
    allowed = exceptions()
    seen: set[str] = set()
    for path in sorted(git_paths()):
        if path.suffix not in SOURCE_SUFFIXES or EXCLUDED_PARTS.intersection(path.parts) or not path.is_file():
            continue
        lines = len(path.read_bytes().splitlines())
        relative = path.relative_to(ROOT)
        name = str(relative)
        if name in allowed:
            seen.add(name)
            continue
        if lines > 1000:
            print(f"FAIL {relative}: {lines} lines (over 1,000)")
            failed = True
        elif lines > 700:
            print(f"REVIEW {relative}: {lines} lines")
        elif lines > 500:
            print(f"WARN {relative}: {lines} lines")
    if allowed - seen:
        print(f"file-size exceptions do not apply to source files: {', '.join(sorted(allowed - seen))}", file=sys.stderr)
        failed = True
    return int(failed)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"file-size check failed: {error}", file=sys.stderr)
        sys.exit(1)
