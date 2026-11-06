#!/usr/bin/env python3
"""Run the offline full checks against one batch of isolated Terraform renders."""
import importlib.util
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "bootstrap" / "scripts"))
sys.path.insert(0, str(HERE / "tests"))

import iam_policy_evaluator as evaluator
import test_iam_policy_guardrails as policy_tests


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


checker = load("guardrail_checker", HERE / "check_iam_policy_guardrails.py")
comparator = load("policy_comparator", HERE.parent / "bootstrap/scripts/compare_bootstrap_policy_split.py")
roots = [evaluator.BOOTSTRAP_MAXIMUM, evaluator.BOOTSTRAP_CREDENTIAL_OPERATIONS,
         evaluator.BOOTSTRAP_STANDING,
         evaluator.BOOTSTRAP_DIAGNOSTICS, evaluator.BOOTSTRAP_TRANSITION,
         evaluator.BOOTSTRAP_ROLE_SECRET_MAXIMUM, evaluator.APPLICATION_MAXIMUM]
plans = evaluator.render_plans(roots)
print("Rendered 7 unique configurations with 2 isolated Terraform initializations")
policy_tests.IsolationTests("assert_application_plan").assert_application_plan(
    plans[evaluator.APPLICATION_MAXIMUM.name]
)
suite = unittest.TestSuite(
    unittest.defaultTestLoader.loadTestsFromTestCase(case)
    for case in (
        policy_tests.ExactVpcEndpointCapabilityTests,
        policy_tests.LambdaHardeningPolicyTests,
    )
)
with mock.patch.object(evaluator, "render_plan", side_effect=lambda root: plans[root.name]):
    if not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful():
        raise SystemExit(1)
checker.render_plan = lambda root: plans[root.name]
comparator.render_plan = lambda root: plans[root.name]
status = checker.main()
if status == 0:
    status = comparator.main()
raise SystemExit(status)
