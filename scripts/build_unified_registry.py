"""Generate the legacy registry mirrors from registry.json.

registry.json is the only catalog edited by hand. An entry without "runtime"
(or with "javascript") is a JavaScript extension; a Python package carries
"runtime": "python", which Mornye app versions with mornyeapp/Mornye#846 hide
from the store and refuse to install.

registry-python.json (Python packages only) and registry-unified.json (every
entry with an explicit runtime) are generated copies kept for setups that
still point at their URLs. Do not edit them by hand.
"""

import argparse
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RUNTIMES = ("javascript", "python")


def runtime_of(entry):
    runtime = entry.get("runtime", "javascript")
    if runtime not in RUNTIMES:
        raise ValueError("Unknown runtime for " + entry.get("id", "?") + ": " + str(runtime))
    return runtime


def mirrors(root=ROOT):
    registry = json.loads((root / "registry.json").read_text())
    seen = set()
    unified, python = [], []
    for entry in registry["extensions"]:
        if entry["id"] in seen:
            raise ValueError("Duplicate extension id: " + entry["id"])
        seen.add(entry["id"])
        runtime = runtime_of(entry)
        fields = {key: value for key, value in entry.items() if key != "runtime"}
        unified.append(dict(fields, runtime=runtime))
        if runtime == "python":
            python.append(fields)
    header = {"version": registry["version"], "updated_at": registry["updated_at"]}
    return {
        "registry-unified.json": dict(header, extensions=unified),
        "registry-python.json": dict(header, extensions=python),
    }


def synchronize(*, check=False, root=ROOT):
    stale = []
    for filename, content in mirrors(root).items():
        destination = root / filename
        expected = json.dumps(content, indent=2, ensure_ascii=False) + "\n"
        if destination.exists() and destination.read_text() == expected:
            continue
        if check:
            stale.append(filename)
        else:
            destination.write_text(expected)
    if stale:
        raise ValueError(", ".join(stale) + " stale; run scripts/build_unified_registry.py")


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
