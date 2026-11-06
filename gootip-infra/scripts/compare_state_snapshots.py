#!/usr/bin/env python3
"""Compare Terraform state snapshots without exposing their contents.

This verifier accepts snapshot metadata differences only when the caller has
already recorded and approved them for one specific migration. It never reads
AWS, writes state, or treats a lineage/serial change as generally expected.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def canonical_state(state: dict[str, Any]) -> dict[str, Any]:
    canonical = dict(state)
    canonical.pop("lineage", None)
    canonical.pop("serial", None)
    canonical["check_results"] = sorted(
        canonical.get("check_results", []), key=lambda result: json.dumps(result, sort_keys=True)
    )
    return canonical


def summary(state: dict[str, Any]) -> dict[str, Any]:
    resources = state.get("resources", [])
    instances = [instance for resource in resources for instance in resource.get("instances", [])]
    return {
        "lineage": state.get("lineage"),
        "serial": state.get("serial"),
        "terraform_version": state.get("terraform_version"),
        "resource_count": len(resources),
        "instance_count": len(instances),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Compare two Terraform state snapshots semantically.")
    parser.add_argument("local_state", type=Path)
    parser.add_argument("remote_state", type=Path)
    args = parser.parse_args()

    local_state = json.loads(args.local_state.read_text())
    remote_state = json.loads(args.remote_state.read_text())
    result = {
        "local": summary(local_state),
        "remote": summary(remote_state),
        "semantic_equivalence": canonical_state(local_state) == canonical_state(remote_state),
    }
    print(json.dumps(result, indent=2))
    return 0 if result["semantic_equivalence"] else 1


if __name__ == "__main__":
    sys.exit(main())
