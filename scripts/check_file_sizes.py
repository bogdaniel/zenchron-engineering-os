#!/usr/bin/env python3
"""Check source file line-count policy from AGENTS.md."""

import subprocess
import sys
from itertools import islice
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_SUFFIXES = {".go", ".py", ".js", ".jsx", ".ts", ".tsx", ".css", ".html", ".yml", ".yaml"}
DEPENDENCY_DIRS = {".git", "node_modules", "vendor"}
GENERATED_DIRS = {"dist", "coverage", "playwright-report", "test-results"}
# ponytail: scan 20 header lines; extend if a supported generator emits its marker later.
GENERATED_HEADER_LINES = 20


def git_paths() -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    return [ROOT / path.decode() for path in result.stdout.split(b"\0") if path]


def exceptions(paths: list[Path]) -> set[str]:
    file = ROOT / "file-size-exceptions.tsv"
    if not file.exists():
        return set()
    entries: set[str] = set()
    source_paths = {str(path.relative_to(ROOT)) for path in paths}
    for number, line in enumerate(file.read_text().splitlines(), 1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        fields = line.split("\t")
        if len(fields) != 2 or not fields[0] or not fields[1].strip() or fields[0] in entries:
            raise ValueError(f"{file.name}:{number}: expected unique path<TAB>reason")
        if fields[0] not in source_paths:
            raise ValueError(f"{file.name}:{number}: stale or untracked path {fields[0]}")
        entries.add(fields[0])
    return entries


def has_generated_header(path: Path) -> bool:
    lines: list[str] = []
    with path.open(encoding="utf-8", errors="replace") as source:
        for line in islice(source, GENERATED_HEADER_LINES):
            comment = line.lstrip()
            if not comment.strip():
                continue
            if not comment.startswith(("#", "//", "/*", "*", "<!--", "*/", "-->")):
                break
            lines.append(comment.casefold())
    header = " ".join(lines)
    return "generated" in header and "do not edit" in header


def should_check(path: Path) -> bool:
    relative = path.relative_to(ROOT)
    if path.is_symlink() or path.suffix not in SOURCE_SUFFIXES or not path.is_file():
        return False
    if any(part in DEPENDENCY_DIRS for part in relative.parts) or relative.parts[0] in GENERATED_DIRS:
        return False
    return not has_generated_header(path)


def main() -> int:
    failed = False
    paths = git_paths()
    allowed = exceptions(paths)
    seen: set[str] = set()
    for path in sorted(paths):
        if not should_check(path):
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
