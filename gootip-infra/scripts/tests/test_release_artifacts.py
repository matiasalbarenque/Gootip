from __future__ import annotations

import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))

import verify_release_artifacts as verifier


class ReleaseArtifactTests(unittest.TestCase):
    def test_archive_layout_is_exact_and_rejects_native_dependencies(self):
        with tempfile.TemporaryDirectory() as directory:
            archive_path = Path(directory) / "function.zip"
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr("dist/lambda.mjs", "export {};")

            entries, _ = verifier.inspect_archive(archive_path, {"dist/lambda.mjs"})
            self.assertEqual(set(entries), {"dist/lambda.mjs"})
            with self.assertRaisesRegex(ValueError, "unexpected ZIP layout"):
                verifier.inspect_archive(archive_path, {"lambda.mjs"})

            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr("dist/native.node", "binary")
            with self.assertRaisesRegex(ValueError, "native dependencies"):
                verifier.inspect_archive(archive_path, None)

    def test_active_release_requires_supported_schema(self):
        with tempfile.TemporaryDirectory() as directory:
            record_path = Path(directory) / "active.json"
            record_path.write_text(json.dumps({"schema_version": 1, "services": {}}))
            self.assertEqual(verifier.load_active_release(record_path)["services"], {})
            record_path.write_text(json.dumps({"schema_version": 2, "services": {}}))
            with self.assertRaisesRegex(ValueError, "schema_version 1"):
                verifier.load_active_release(record_path)

    def test_compares_inputs_and_shared_layer_to_active_release(self):
        services = {
            "auth": {"input_fingerprint_sha256": "auth-current"},
            "core": {"input_fingerprint_sha256": "core-current"},
        }
        previous = {
            "services": {
                "auth": {"input_fingerprint_sha256": "auth-current"},
                "core": {"input_fingerprint_sha256": "core-old"},
            }
        }
        self.assertEqual(verifier.compare_services(services, previous, False), ["core"])
        self.assertEqual(
            verifier.compare_services(services, previous, True), ["auth", "core"]
        )


if __name__ == "__main__":
    unittest.main()
