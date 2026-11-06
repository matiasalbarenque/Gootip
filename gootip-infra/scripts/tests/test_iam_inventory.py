"""Pure tests for canonical Terraform IAM inventory extraction."""

from __future__ import annotations

import sys
import json
import unittest
from unittest import mock
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))

import compare_iam_inventory as inventory  # noqa: E402


class ConfigurationGateTests(unittest.TestCase):
    @staticmethod
    def plan(kind, actions):
        return {"resource_changes": [{
            "address": f"{kind}.example", "mode": "managed", "type": kind,
            "change": {"actions": actions},
        }]}

    def test_unapplied_configuration_fails_even_when_state_and_aws_match(self):
        for kind, actions in (
            ("aws_iam_policy", ["update"]),
            ("aws_iam_role_policy_attachment", ["delete"]),
            ("aws_iam_role", ["delete", "create"]),
        ):
            with self.subTest(kind=kind):
                result = mock.Mock(stdout=json.dumps(self.plan(kind, actions)))
                # The old comparator would accept this matching state/live pair.
                policies = {"arn": ("policy", {"Statement": []})}
                roles = {"role": {"arn"}}
                with mock.patch.object(inventory.subprocess, "run", return_value=result), \
                     mock.patch.object(inventory, "terraform_state") as state, \
                     mock.patch.object(inventory, "canonical_inventory", return_value=(policies, roles)), \
                     mock.patch.object(inventory, "live_policy_document", return_value={"Statement": []}) as live, \
                     mock.patch.object(inventory, "live_role_attachments", return_value={"arn"}):
                    with self.assertRaisesRegex(ValueError, "Configuration differs"):
                        inventory.compare("mfa", ["dev.tfvars"], ["dev.tfvars"])
                state.assert_not_called()
                live.assert_not_called()

    def test_noop_iam_and_unrelated_changes_pass_but_incomplete_plan_fails(self):
        plan = self.plan("aws_iam_policy", ["no-op"])
        plan["resource_changes"] += self.plan("aws_lambda_function", ["update"])["resource_changes"]
        inventory.check_configuration_plan(plan)
        for flag in ({"complete": False}, {"errored": True}):
            with self.assertRaisesRegex(ValueError, "incomplete or errored"):
                inventory.check_configuration_plan({**plan, **flag})

    def test_effective_var_files_profile_and_temporary_plan_are_used(self):
        result = mock.Mock(stdout=json.dumps(self.plan("aws_iam_policy", ["no-op"])))
        root = inventory.TERRAFORM_ROOTS[1]
        with mock.patch.object(inventory.subprocess, "run", return_value=result) as run:
            inventory.check_configuration(root, "mfa", ["dev.tfvars", "current.local.tfvars"])
        plan_call, show_call = run.call_args_list
        command = plan_call.args[0]
        self.assertIn("-refresh=false", command)
        self.assertIn("-input=false", command)
        self.assertEqual(command[-2:], ["-var-file=dev.tfvars", "-var-file=current.local.tfvars"])
        self.assertEqual(plan_call.kwargs["env"]["AWS_PROFILE"], "mfa")
        self.assertEqual(command[1], f"-chdir={root}")
        self.assertFalse(Path(show_call.args[0][-1]).parent.exists())


class CanonicalInventoryTests(unittest.TestCase):
    def test_known_access_analyzer_corrections_remain_in_source(self):
        root = Path(__file__).resolve().parents[2]
        source = (root / "bootstrap" / "iam.tf").read_text()
        self.assertNotIn('"budgets:DeleteBudget"', source)
        self.assertIn('variable = "ec2-instance-connect:remotePort"', source)
        start = source.index('variable = "ec2-instance-connect:remotePort"')
        self.assertIn('test     = "NumericEquals"', source[start - 80 : start])

    def test_collects_managed_policies_and_all_role_attachments(self):
        state = {
            "resources": [
                {
                    "type": "aws_iam_policy",
                    "address": "aws_iam_policy.managed",
                    "instances": [{"attributes": {"arn": "arn:managed", "name": "managed", "policy": '{"Statement": []}'}}],
                },
                {
                    "type": "aws_iam_role",
                    "address": "aws_iam_role.role",
                    "instances": [{"attributes": {"name": "gootip-role", "path": "/gootip/bootstrap/"}}],
                },
                {
                    "type": "aws_iam_role_policy_attachment",
                    "address": "aws_iam_role_policy_attachment.managed",
                    "instances": [{"attributes": {"role": "gootip-role", "policy_arn": "arn:managed"}}],
                },
                {
                    "type": "aws_iam_role_policy_attachment",
                    "address": "aws_iam_role_policy_attachment.aws_managed",
                    "instances": [{"attributes": {"role": "gootip-role", "policy_arn": "arn:aws:iam::aws:policy/ReadOnlyAccess"}}],
                },
            ]
        }

        policies, roles = inventory.canonical_inventory([state])
        self.assertEqual(policies["arn:managed"][0], "managed")
        self.assertEqual(
            roles["gootip-role"],
            {"arn:managed", "arn:aws:iam::aws:policy/ReadOnlyAccess"},
        )

    def test_boundaries_are_not_counted_as_role_attachments(self):
        state = {
            "resources": [
                {"type": "aws_iam_policy", "address": "p", "instances": [{"attributes": {"arn": "p", "name": "p", "policy": "{}"}}]},
                {"type": "aws_iam_role", "address": "r", "instances": [{"attributes": {"name": "role", "path": "/gootip/", "permissions_boundary": "p"}}]},
            ]
        }
        _, roles = inventory.canonical_inventory([state])
        self.assertEqual(roles, {"role": set()})

    def test_missing_policy_document_fails_closed(self):
        state = {
            "resources": [
                {"type": "aws_iam_policy", "address": "aws_iam_policy.unknown", "instances": [{"attributes": {"arn": "arn:missing", "name": "missing"}}]},
            ]
        }
        with self.assertRaisesRegex(ValueError, "lacks policy ARN/document"):
            inventory.canonical_inventory([state])

    def test_semantically_equal_policy_order_passes_and_attachment_drift_fails(self):
        policies = {"arn": ("policy", {"Statement": [{"Action": ["a", "b"], "Effect": "Allow", "Resource": "*"}]})}
        roles = {"role": {"arn", "aws-managed"}}
        actual_policy = {"Statement": [{"Resource": "*", "Effect": "Allow", "Action": ["b", "a"]}]}
        with mock.patch("builtins.print") as output:
            result = inventory.compare_inventory(
                policies,
                roles,
                lambda _arn: actual_policy,
                lambda _role: {"arn"},
            )
        self.assertEqual(result, 1)
        messages = [call.args[0] for call in output.call_args_list]
        self.assertIn("policy policy: MATCH", messages)
        self.assertTrue(any("role role: attachments=1 DRIFT" in message for message in messages))


if __name__ == "__main__":
    unittest.main()
