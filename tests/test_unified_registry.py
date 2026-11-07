import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("catalog", ROOT / "scripts/build_unified_registry.py")
catalog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(catalog)


class UnifiedRegistryTest(unittest.TestCase):
    def test_generated_catalog_matches_both_inputs(self):
        catalog.synchronize(check=True)
        registry = json.loads((ROOT / "registry-unified.json").read_text())
        for filename, runtime in [("registry.json", "javascript"), ("registry-python.json", "python")]:
            for entry in json.loads((ROOT / filename).read_text())["extensions"]:
                expected = dict(entry, runtime=runtime)
                self.assertIn(expected, registry["extensions"])

    def test_package_updates_invalidate_and_refresh_only_the_shared_catalog(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for filename in ["registry.json", "registry-python.json"]:
                (root / filename).write_bytes((ROOT / filename).read_bytes())
            catalog.synchronize(root=root)
            python = json.loads((root / "registry-python.json").read_text())
            python["extensions"][0].update(version="99.0.0", sha256="f" * 64)
            (root / "registry-python.json").write_text(json.dumps(python))
            originals = [(root / filename).read_bytes() for filename in ["registry.json", "registry-python.json"]]
            with self.assertRaisesRegex(ValueError, "stale"):
                catalog.synchronize(check=True, root=root)
            catalog.synchronize(root=root)
            catalog.synchronize(check=True, root=root)
            for filename, data in zip(["registry.json", "registry-python.json"], originals):
                self.assertEqual((root / filename).read_bytes(), data)

    def test_duplicate_ids_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for filename in ["registry.json", "registry-python.json"]:
                (root / filename).write_text(json.dumps({
                    "version": 1, "updated_at": "2026-11-07T00:00:00Z",
                    "extensions": [{"id": "duplicate"}],
                }))
            with self.assertRaisesRegex(ValueError, "Duplicate"):
                catalog.combined_registry(root)
