import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("catalog", ROOT / "scripts/build_unified_registry.py")
catalog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(catalog)


def copy_registries(root):
    for filename in ["registry.json", "registry-python.json", "registry-unified.json"]:
        (root / filename).write_bytes((ROOT / filename).read_bytes())


class SingleRegistryTest(unittest.TestCase):
    def test_mirrors_are_generated_from_registry_json(self):
        catalog.synchronize(check=True)
        registry = json.loads((ROOT / "registry.json").read_text())
        unified = json.loads((ROOT / "registry-unified.json").read_text())
        python = json.loads((ROOT / "registry-python.json").read_text())
        self.assertEqual([e["id"] for e in unified["extensions"]], [e["id"] for e in registry["extensions"]])
        for entry in registry["extensions"]:
            runtime = entry.get("runtime", "javascript")
            fields = {k: v for k, v in entry.items() if k != "runtime"}
            self.assertIn(dict(fields, runtime=runtime), unified["extensions"])
            self.assertEqual(fields in python["extensions"], runtime == "python")

    def test_python_packages_in_registry_json_are_marked(self):
        registry = json.loads((ROOT / "registry.json").read_text())
        utilities = [e for e in registry["extensions"] if e["id"] == "utilities"]
        self.assertEqual(len(utilities), 1)
        self.assertEqual(utilities[0]["runtime"], "python")
        for entry in registry["extensions"]:
            if "python" in entry.get("tags", []):
                self.assertEqual(entry.get("runtime"), "python", entry["id"])

    def test_editing_registry_json_makes_the_mirrors_stale_until_regenerated(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            copy_registries(root)
            registry = json.loads((root / "registry.json").read_text())
            next(e for e in registry["extensions"] if e["id"] == "utilities").update(
                version="99.0.0", sha256="f" * 64
            )
            (root / "registry.json").write_text(json.dumps(registry))
            with self.assertRaisesRegex(ValueError, "stale"):
                catalog.synchronize(check=True, root=root)
            catalog.synchronize(root=root)
            catalog.synchronize(check=True, root=root)
            python = json.loads((root / "registry-python.json").read_text())
            self.assertEqual(python["extensions"][0]["version"], "99.0.0")
            self.assertNotIn("runtime", python["extensions"][0])

    def test_duplicate_ids_and_unknown_runtimes_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for extensions, message in [
                ([{"id": "duplicate"}, {"id": "duplicate"}], "Duplicate"),
                ([{"id": "lua", "runtime": "lua"}], "Unknown runtime"),
            ]:
                (root / "registry.json").write_text(json.dumps({
                    "version": 1, "updated_at": "2026-11-07T00:00:00Z", "extensions": extensions,
                }))
                with self.assertRaisesRegex(ValueError, message):
                    catalog.mirrors(root)
