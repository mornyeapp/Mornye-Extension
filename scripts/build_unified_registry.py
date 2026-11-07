"""Generate an opt-in shared catalog without changing legacy registries."""

import argparse
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def combined_registry(root=ROOT):
    javascript = json.loads((root / "registry.json").read_text())
    python = json.loads((root / "registry-python.json").read_text())
    entries = []
    seen = set()
    for registry, runtime in [(javascript, "javascript"), (python, "python")]:
        for original in registry["extensions"]:
            entry = dict(original)
            if entry["id"] in seen:
                raise ValueError("Duplicate extension id: " + entry["id"])
            if entry.get("runtime", runtime) != runtime:
                raise ValueError("Unexpected runtime for " + entry["id"])
            seen.add(entry["id"])
            entry["runtime"] = runtime
            entries.append(entry)
    return {
        "version": max(javascript["version"], python["version"]),
        "updated_at": max(javascript["updated_at"], python["updated_at"]),
        "extensions": entries,
    }


def synchronize(*, check=False, root=ROOT):
    destination = root / "registry-unified.json"
    expected = json.dumps(combined_registry(root), indent=2, ensure_ascii=False) + "\n"
    if destination.exists() and destination.read_text() == expected:
        return
    if check:
        raise ValueError("registry-unified.json is stale; run scripts/build_unified_registry.py")
    destination.write_text(expected)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Verify without writing")
    args = parser.parse_args()
    try:
        synchronize(check=args.check)
    except ValueError as error:
        parser.exit(1, str(error) + "\n")


if __name__ == "__main__":
    main()
