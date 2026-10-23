#!/usr/bin/env python3
"""FlowReview - deterministic pull-request review analyzer.

Reads the changes a pull request introduces (merge-base of BASE..HEAD) and
reports where a human reviewer should look: build scripts, dependency changes,
automation changes, removed authorization checks, contract upgrade paths,
`unsafe` code and panics in contract code, missing tests, and oversized PRs.

Like FlowGuard's scan-pr.sh it reads git objects only. It never checks out,
builds, installs or executes anything from HEAD, so it is safe to run on
untrusted pull requests. Findings never quote file content, only paths, line
numbers and dependency names.

Usage: analyze.py BASE_REF HEAD_REF

Output: one JSON object on stdout:
  {"risk": "low"|"medium"|"high",
   "totals": {"files": N, "additions": N, "deletions": N},
   "files": [{"path", "status", "category", "additions", "deletions"}],
   "findings": [{"level": "high"|"medium", "location", "message"}],
   "tests_changed": bool, "contract_code_changed": bool}

Exit codes: 0 = analyzed, 3 = FlowReview could not run.
"""

import json
import posixpath
import re
import subprocess
import sys
import tomllib

LARGE_PR_LINES = 800

# Git must never let repository config or attributes from the PR influence the diff.
GIT_DIFF = ["git", "-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-textconv", "--no-renames"]

AUTOMATION_PREFIXES = (".github/", "scripts/", ".vscode/", ".devcontainer/")
DEPENDENCY_TABLES = ("dependencies", "dev-dependencies", "build-dependencies")


def die(message):
    print(f"flowreview: {message}", file=sys.stderr)
    sys.exit(3)


def git(*args):
    result = subprocess.run(["git", *args], capture_output=True, text=True)
    if result.returncode != 0:
        die(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout


def show(rev, path):
    """File content at a revision, or None when absent there."""
    result = subprocess.run(["git", "show", f"{rev}:{path}"], capture_output=True, text=True)
    return result.stdout if result.returncode == 0 else None


def contract_crates(rev):
    """Directories (with trailing slash) of crates that build a cdylib contract."""
    crates = set()
    for path in git("ls-tree", "-r", "--name-only", rev).splitlines():
        if path.endswith("/Cargo.toml") or path == "Cargo.toml":
            text = show(rev, path) or ""
            try:
                manifest = tomllib.loads(text)
            except tomllib.TOMLDecodeError:
                continue
            if "cdylib" in manifest.get("lib", {}).get("crate-type", []):
                crates.add(path[: -len("Cargo.toml")])
    return crates


def test_modules(rev):
    """Rust files that are only compiled for tests: `#[cfg(test)] mod name;`."""
    paths = set()
    for path in git("ls-tree", "-r", "--name-only", rev).splitlines():
        if not path.endswith(".rs"):
            continue
        directory = posixpath.dirname(path)
        stem = posixpath.basename(path)[:-3]
        if stem not in ("lib", "main", "mod"):
            directory = posixpath.join(directory, stem)
        for name in re.findall(r"#\[cfg\(test\)\]\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;", show(rev, path) or ""):
            paths.add(posixpath.join(directory, f"{name}.rs"))
            paths.add(posixpath.join(directory, name, "mod.rs"))
    return paths


def is_test_path(path, test_only):
    name = path.rsplit("/", 1)[-1]
    return (
        path in test_only
        or "/tests/" in f"/{path}"
        or "/__tests__/" in f"/{path}"
        or name in ("test.rs", "tests.rs")
        or name.startswith("test_")
        or name.endswith("_test.rs")
        or re.search(r"\.(test|spec)\.[cm]?[jt]sx?$", name) is not None
    )


def categorize(path, contract_dirs, crate_roots, test_only):
    if path.startswith(AUTOMATION_PREFIXES) or path.endswith((".bat", ".cmd", ".sh")):
        return "automation"
    name = path.rsplit("/", 1)[-1]
    if name == "build.rs" and path[: -len("build.rs")] in crate_roots:
        return "build-script"
    if name in ("Cargo.toml", "package.json"):
        return "manifest"
    if name in ("Cargo.lock", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"):
        return "lockfile"
    if is_test_path(path, test_only):
        return "tests"
    if path.endswith(".rs"):
        if any(path.startswith(d) for d in contract_dirs):
            return "contract"
        return "rust"
    if path.endswith((".md", ".mdx", ".txt")) or path.startswith("docs/"):
        return "docs"
    return "other"


def changed_lines(base, head, path):
    """(added, removed) lists of (line_number, text) for one file."""
    diff = subprocess.run(GIT_DIFF + ["-U0", base, head, "--", path], capture_output=True, text=True).stdout
    added, removed = [], []
    new_line = old_line = 0
    for line in diff.splitlines():
        hunk = re.match(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@", line)
        if hunk:
            old_line, new_line = int(hunk.group(1)), int(hunk.group(2))
        elif line.startswith("+") and not line.startswith("+++"):
            added.append((new_line, line[1:]))
            new_line += 1
        elif line.startswith("-") and not line.startswith("---"):
            removed.append((old_line, line[1:]))
            old_line += 1
    return added, removed


def line_list(numbers, limit=6):
    shown = ",".join(str(n) for n in numbers[:limit])
    return shown + (f" (+{len(numbers) - limit} more)" if len(numbers) > limit else "")


def cargo_dependencies(text):
    """{name: (table, spec)} across dependency tables, including target-specific ones."""
    try:
        manifest = tomllib.loads(text or "")
    except tomllib.TOMLDecodeError:
        return None
    tables = [manifest] + list(manifest.get("target", {}).values())
    workspace = manifest.get("workspace", {})
    if "dependencies" in workspace:
        tables.append(workspace)
    deps = {}
    for table in tables:
        for kind in DEPENDENCY_TABLES:
            for name, spec in table.get(kind, {}).items():
                deps[name] = (kind, spec if isinstance(spec, dict) else {"version": spec})
    return deps


def npm_dependencies(text):
    try:
        manifest = json.loads(text or "{}")
    except json.JSONDecodeError:
        return None
    deps = {}
    for kind in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
        deps.update(manifest.get(kind) or {})
    return deps


def main():
    if len(sys.argv) != 3:
        die("usage: analyze.py BASE_REF HEAD_REF")
    base = git("rev-parse", "--verify", "--quiet", f"{sys.argv[1]}^{{commit}}").strip()
    head = git("rev-parse", "--verify", "--quiet", f"{sys.argv[2]}^{{commit}}").strip()
    merge_base = git("merge-base", base, head).strip()

    contract_dirs = contract_crates(head) | contract_crates(merge_base)
    test_only = test_modules(head)
    crate_roots = {
        p[: -len("Cargo.toml")] for p in git("ls-tree", "-r", "--name-only", head).splitlines() if p.endswith("Cargo.toml")
    }

    findings = []

    def flag(level, location, message):
        findings.append({"level": level, "location": location, "message": message})

    files = []
    numstat = subprocess.run(GIT_DIFF + ["--numstat", merge_base, head], capture_output=True, text=True).stdout
    status_of = {}
    for line in subprocess.run(GIT_DIFF + ["--name-status", merge_base, head], capture_output=True, text=True).stdout.splitlines():
        status, _, path = line.partition("\t")
        status_of[path] = {"A": "added", "D": "deleted", "M": "modified"}.get(status[:1], "changed")
    for line in numstat.splitlines():
        adds, dels, path = line.split("\t", 2)
        files.append({
            "path": path,
            "status": status_of.get(path, "changed"),
            "category": categorize(path, contract_dirs, crate_roots, test_only),
            "additions": int(adds) if adds.isdigit() else 0,
            "deletions": int(dels) if dels.isdigit() else 0,
        })

    tests_changed = False
    contract_code_changed = False
    for f in files:
        path, category = f["path"], f["category"]
        if category == "automation":
            flag("high", path, "changes repository automation or scripts that run in CI or on contributors' machines")
        elif category == "build-script":
            flag("high", path, "Cargo build script: runs arbitrary code on every machine that compiles the crate")
        if category == "tests":
            tests_changed = True
        added, removed = changed_lines(merge_base, head, path)
        if path.endswith(".rs") and any(re.search(r"#\[(test|cfg\(test\))\]", text) for _, text in added):
            tests_changed = True
        if category == "contract":
            contract_code_changed = True
            in_test_block = False
            unsafe_lines, panic_lines = [], []
            for number, text in added:
                if re.search(r"#\[cfg\(test\)\]", text):
                    in_test_block = True
                if in_test_block:
                    continue
                code = text.split("//", 1)[0]
                if re.search(r"\bunsafe\b", code):
                    unsafe_lines.append(number)
                if re.search(r"\.unwrap\(\)|\.expect\(|\bpanic!\(", code):
                    panic_lines.append(number)
                if "update_current_contract_wasm" in code:
                    flag("high", f"{path}:{number}", "contract upgrade path: who may replace this contract's code?")
            if unsafe_lines:
                flag("medium", f"{path}:{line_list(unsafe_lines)}", "`unsafe` code in a contract")
            if panic_lines:
                flag("medium", f"{path}:{line_list(panic_lines)}", "can panic: prefer returning a contract error")
            for number, text in removed:
                if re.search(r"\.require_auth(_for_args)?\(", text.split("//", 1)[0]):
                    flag("high", f"{path}:{number}", "authorization check removed (`require_auth`)")

        name = path.rsplit("/", 1)[-1]
        if name == "Cargo.toml":
            before = cargo_dependencies(show(merge_base, path))
            after = cargo_dependencies(show(head, path))
            if f["status"] == "modified" and (before is None or after is None):
                flag("medium", path, "manifest could not be parsed; review dependency changes by hand")
            for dep, (kind, spec) in sorted((after or {}).items()):
                if before is not None and before.get(dep) == (kind, spec):
                    continue
                label = {"dev-dependencies": "dev-dependency", "build-dependencies": "build-dependency"}.get(kind, "dependency")
                escapes_repo = "path" in spec and posixpath.normpath(
                    posixpath.join(posixpath.dirname(path), str(spec["path"]))
                ).startswith("..")
                if "git" in spec:
                    flag("high", path, f"{label} `{dep}` comes from a git source, not crates.io")
                elif escapes_repo or "registry" in spec:
                    flag("high", path, f"{label} `{dep}` comes from outside this repository and crates.io")
                elif before is not None and dep not in before:
                    flag("medium", path, f"new {label} `{dep}`")
                elif before is not None:
                    flag("medium", path, f"{label} `{dep}` changed")
            if 'build = "' in "".join(text for _, text in added):
                flag("high", path, "declares a custom build script")
        elif name == "package.json":
            before = npm_dependencies(show(merge_base, path))
            after = npm_dependencies(show(head, path))
            for dep, spec in sorted((after or {}).items()):
                if before is not None and before.get(dep) == spec:
                    continue
                if re.match(r"^(git\+|git:|github:|https?:|file:|link:)", str(spec)) or ("/" in str(spec) and not str(spec).startswith("@")):
                    flag("high", path, f"npm dependency `{dep}` comes from a non-registry source")
                elif before is not None and dep not in before:
                    flag("medium", path, f"new npm dependency `{dep}`")
                elif before is not None:
                    flag("medium", path, f"npm dependency `{dep}` changed")

    if contract_code_changed and not tests_changed:
        flag("medium", "tests", "contract code changed but no tests were added or changed")

    total_changed = sum(f["additions"] + f["deletions"] for f in files)
    if total_changed > LARGE_PR_LINES:
        flag("medium", "size", f"{total_changed} changed lines: large PRs are hard to review; consider splitting")

    levels = {f["level"] for f in findings}
    risk = "high" if "high" in levels else "medium" if "medium" in levels else "low"
    json.dump({
        "risk": risk,
        "totals": {
            "files": len(files),
            "additions": sum(f["additions"] for f in files),
            "deletions": sum(f["deletions"] for f in files),
        },
        "files": files,
        "findings": findings,
        "tests_changed": tests_changed,
        "contract_code_changed": contract_code_changed,
    }, sys.stdout, indent=2)
    print()


if __name__ == "__main__":
    main()
