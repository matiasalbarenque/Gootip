import importlib.util
import unittest
from pathlib import Path


spec = importlib.util.spec_from_file_location(
    "compare_state_snapshots", Path(__file__).resolve().parents[2] / "scripts" / "compare_state_snapshots.py"
)
compare_state_snapshots = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(compare_state_snapshots)


class StateEquivalenceTests(unittest.TestCase):
    def test_allows_only_approved_snapshot_metadata_and_check_order(self):
        local = {
            "lineage": "local-lineage",
            "serial": 20,
            "resources": [{"address": "aws_iam_role.example", "instances": [{"attributes": {"id": "example"}}]}],
            "check_results": [{"config_addr": "var.env"}, {"config_addr": "var.region"}],
        }
        remote = {
            "lineage": "remote-lineage",
            "serial": 1,
            "resources": [{"address": "aws_iam_role.example", "instances": [{"attributes": {"id": "example"}}]}],
            "check_results": [{"config_addr": "var.region"}, {"config_addr": "var.env"}],
        }

        self.assertEqual(
            compare_state_snapshots.canonical_state(local),
            compare_state_snapshots.canonical_state(remote),
        )

    def test_rejects_resource_id_divergence(self):
        local = {"resources": [{"address": "aws_iam_role.example", "instances": [{"attributes": {"id": "one"}}]}]}
        remote = {"resources": [{"address": "aws_iam_role.example", "instances": [{"attributes": {"id": "two"}}]}]}

        self.assertNotEqual(
            compare_state_snapshots.canonical_state(local),
            compare_state_snapshots.canonical_state(remote),
        )

    def test_rejects_managed_attribute_divergence(self):
        local = {
            "resources": [
                {
                    "address": "aws_iam_policy.example",
                    "instances": [{"attributes": {"id": "example", "policy": "least-privilege"}}],
                }
            ],
            "outputs": {"state_key": {"value": "bootstrap/terraform.tfstate"}},
        }
        remote = {
            "resources": [
                {
                    "address": "aws_iam_policy.example",
                    "instances": [{"attributes": {"id": "example", "policy": "broadened"}}],
                }
            ],
            "outputs": {"state_key": {"value": "bootstrap/terraform.tfstate"}},
        }

        self.assertNotEqual(
            compare_state_snapshots.canonical_state(local),
            compare_state_snapshots.canonical_state(remote),
        )
