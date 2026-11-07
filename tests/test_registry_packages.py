"""Validate published registries, including packages without a source builder."""

import ast
import hashlib
import json
import unittest
from pathlib import Path
from urllib.parse import urlparse
from zipfile import ZipFile


ROOT = Path(__file__).resolve().parents[1]


class RegistryPackagesTest(unittest.TestCase):
    def test_registry_entries_match_their_packages(self):
        for registry in sorted(ROOT.glob("registry*.json")):
            entries = json.loads(registry.read_text())["extensions"]
            self.assertEqual(len(entries), len({entry["id"] for entry in entries}))
            for entry in entries:
                with self.subTest(registry=registry.name, extension=entry["id"]):
                    package = ROOT / "extensions" / Path(urlparse(entry["download_url"]).path).name
                    self.assertEqual(entry["sha256"], hashlib.sha256(package.read_bytes()).hexdigest())
                    with ZipFile(package) as archive:
                        self.assertIsNone(archive.testzip())
                        manifest = json.loads(archive.read("manifest.json"))
                    self.assertEqual(entry["version"], manifest["version"])
                    self.assertEqual(entry["id"], manifest["name"])
                    if "runtime" in entry:
                        self.assertEqual(entry["runtime"], manifest.get("runtime", "javascript"))

    def test_default_registry_stays_compatible_with_javascript_only_apps(self):
        for entry in json.loads((ROOT / "registry.json").read_text())["extensions"]:
            package = ROOT / "extensions" / Path(urlparse(entry["download_url"]).path).name
            with self.subTest(extension=entry["id"]), ZipFile(package) as archive:
                manifest = json.loads(archive.read("manifest.json"))
                self.assertEqual(manifest.get("runtime", "javascript"), "javascript")

    def test_packaged_python_modules_have_valid_syntax(self):
        for package in sorted((ROOT / "extensions").glob("*.sflx")):
            with ZipFile(package) as archive:
                for name in archive.namelist():
                    if name.endswith(".py"):
                        with self.subTest(package=package.name, module=name):
                            ast.parse(archive.read(name), filename=name)


if __name__ == "__main__":
    unittest.main()
