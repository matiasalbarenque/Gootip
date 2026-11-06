"""Validate built Auth/Core Lambda archives and produce a release record."""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import subprocess
import sys
import zipfile
from pathlib import Path

MAX_UNCOMPRESSED_BYTES = 250 * 1024 * 1024
SERVICES = {
    "auth": {
        "directory": "gootip-auth",
        "inputs": (
            "package.json",
            "pnpm-lock.yaml",
            "tsconfig*.json",
            "src/**",
            "scripts/**",
            "migrations/**",
        ),
        "artifacts": {
            "api": ("lambda.zip", {"dist/lambda.mjs"}, None),
            "migration": (
                "migration-lambda.zip",
                None,
                "migrations/manifest.json",
            ),
        },
    },
    "core": {
        "directory": "gootip-core",
        "inputs": (
            "package.json",
            "pnpm-lock.yaml",
            "tsconfig*.json",
            "src/**",
            "scripts/**",
        ),
        "artifacts": {
            "api": ("lambda.zip", {"dist/lambda.mjs"}, None),
            "migration": (
                "migration-lambda.zip",
                {"dist/migrations/lambda.mjs", "dist/migrations/manifest.json"},
                "dist/migrations/manifest.json",
            ),
        },
    },
}
NATIVE_SUFFIXES = (".node", ".so", ".dylib", ".dll", ".a")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tracked_input_fingerprint(
    repo: Path, directory: str, patterns: tuple[str, ...]
) -> str:
    tracked = subprocess.run(
        ["git", "-C", str(repo), "ls-files", "-z", f"{directory}/"],
        check=True,
        capture_output=True,
    ).stdout.split(b"\0")
    root = repo / directory
    files = sorted(
        Path(raw.decode()).relative_to(directory)
        for raw in tracked
        if raw
        and any(
            fnmatch.fnmatchcase(
                Path(raw.decode()).relative_to(directory).as_posix(), pattern
            )
            for pattern in patterns
        )
    )
    digest = hashlib.sha256()
    for relative in files:
        path = root / relative
        digest.update(relative.as_posix().encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    digest.update(b".nvmrc\0")
    digest.update((repo / ".nvmrc").read_bytes())
    return digest.hexdigest()


def inspect_archive(
    path: Path, expected: set[str] | None
) -> tuple[dict[str, int], int]:
    if not path.is_file():
        raise ValueError(f"missing artifact: {path}")
    with zipfile.ZipFile(path) as archive:
        entries = {item.filename: item.file_size for item in archive.infolist()}
        if len(entries) != len(archive.infolist()):
            raise ValueError(f"duplicate ZIP entries in {path}")
        if expected is not None and set(entries) != expected:
            raise ValueError(
                f"unexpected ZIP layout in {path}: expected {sorted(expected)}, got {sorted(entries)}"
            )
        native = [name for name in entries if name.lower().endswith(NATIVE_SUFFIXES)]
        if native:
            raise ValueError(
                f"native dependencies are not allowed in bundled Node ZIP {path}: {native}"
            )
    return entries, path.stat().st_size


def load_active_release(path: Path) -> dict:
    try:
        record = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(
            f"cannot read active-release record {path}: {error}"
        ) from error
    if record.get("schema_version") != 1 or not isinstance(
        record.get("services"), dict
    ):
        raise ValueError(
            "active-release record must have schema_version 1 and services"
        )
    return record


def compare_services(
    current: dict[str, dict], previous: dict, layer_changed: bool
) -> list[str]:
    return sorted(
        service
        for service, details in current.items()
        if layer_changed
        or previous.get("services", {}).get(service, {}).get("input_fingerprint_sha256")
        != details["input_fingerprint_sha256"]
    )


def create_record(repo: Path, active_release: Path | None) -> dict:
    layer_path = repo / "gootip-infra/rds-ca-layer.zip"
    layer_entries, layer_compressed = inspect_archive(layer_path, None)
    layer_uncompressed = sum(layer_entries.values())
    if layer_uncompressed > MAX_UNCOMPRESSED_BYTES:
        raise ValueError("RDS CA layer exceeds Lambda's 250 MiB uncompressed limit")

    services: dict[str, dict] = {}
    for service, config in SERVICES.items():
        project = repo / config["directory"]
        artifacts: dict[str, dict] = {}
        for name, (filename, expected, manifest_name) in config["artifacts"].items():
            path = project / filename
            if service == "auth" and name == "migration":
                with zipfile.ZipFile(path) as archive:
                    manifest_bytes = archive.read("migrations/manifest.json")
                    manifest = json.loads(manifest_bytes)
                    if (
                        manifest_bytes
                        != (project / "migrations/manifest.json").read_bytes()
                    ):
                        raise ValueError(
                            "Auth migration ZIP manifest differs from committed manifest"
                        )
                    for migration in manifest.get("migrations", []):
                        filename_in_manifest = migration["file"]
                        if Path(filename_in_manifest).name != filename_in_manifest:
                            raise ValueError(
                                "Auth manifest contains an unsafe migration filename"
                            )
                        sql_bytes = archive.read(f"migrations/{filename_in_manifest}")
                        if (
                            sql_bytes
                            != (
                                project / "migrations" / filename_in_manifest
                            ).read_bytes()
                        ):
                            raise ValueError(
                                f"Auth migration ZIP differs from committed SQL: {filename_in_manifest}"
                            )
                        if hashlib.sha256(sql_bytes).hexdigest() != migration["sha256"]:
                            raise ValueError(
                                f"Auth migration digest mismatch: {filename_in_manifest}"
                            )
                sql_files = {
                    f"migrations/{migration['file']}"
                    for migration in manifest.get("migrations", [])
                }
                expected = {
                    "dist/migrations/lambda.mjs",
                    "migrations/manifest.json",
                    *sql_files,
                }
            entries, compressed = inspect_archive(path, expected)
            if service == "core" and name == "migration":
                with zipfile.ZipFile(path) as archive:
                    manifest_bytes = archive.read("dist/migrations/manifest.json")
                built_manifest = (
                    project / "dist/migrations/manifest.json"
                ).read_bytes()
                if manifest_bytes != built_manifest:
                    raise ValueError(
                        "Core migration ZIP manifest differs from the generated manifest"
                    )
                manifest = json.loads(manifest_bytes)
                current_commit = subprocess.run(
                    ["git", "-C", str(repo), "rev-parse", "HEAD"],
                    check=True,
                    capture_output=True,
                    text=True,
                ).stdout.strip()
                if manifest.get("commit_sha") != current_commit:
                    raise ValueError(
                        "Core migration manifest commit does not match the checked-out SHA"
                    )
                for migration in manifest.get("migrations", []):
                    source_name = migration["name"][: -len(str(migration["timestamp"]))]
                    source = (
                        project
                        / "src/config/database/migrations"
                        / (f"{migration['timestamp']}-{source_name}.ts")
                    )
                    if sha256_file(source) != migration["source_sha256"]:
                        raise ValueError(
                            f"Core migration source digest mismatch: {source.name}"
                        )
            total_uncompressed = sum(entries.values()) + layer_uncompressed
            if total_uncompressed > MAX_UNCOMPRESSED_BYTES:
                raise ValueError(
                    f"{service}/{name} plus RDS CA layer is {total_uncompressed} bytes; "
                    f"Lambda allows {MAX_UNCOMPRESSED_BYTES}"
                )
            manifest_digest = None
            if manifest_name:
                try:
                    with zipfile.ZipFile(path) as archive:
                        manifest_digest = hashlib.sha256(
                            archive.read(manifest_name)
                        ).hexdigest()
                except KeyError as error:
                    raise ValueError(
                        f"{path} is missing manifest {manifest_name}"
                    ) from error
            artifacts[name] = {
                "filename": filename,
                "sha256": sha256_file(path),
                "compressed_bytes": compressed,
                "uncompressed_bytes": sum(entries.values()),
                "layer_uncompressed_bytes": layer_uncompressed,
                "migration_manifest_sha256": manifest_digest,
            }
        services[service] = {
            "input_fingerprint_sha256": tracked_input_fingerprint(
                repo, config["directory"], config["inputs"]
            ),
            "artifacts": artifacts,
        }

    changed = sorted(services)
    previous_sha = None
    previous_layer_sha = None
    if active_release:
        previous = load_active_release(active_release)
        previous_sha = previous.get("commit_sha")
        previous_layer_sha = previous.get("layer", {}).get("sha256")
        changed = compare_services(
            services,
            previous,
            previous_layer_sha != sha256_file(layer_path),
        )

    package_managers = {
        name: json.loads((repo / f"gootip-{name}/package.json").read_text())[
            "packageManager"
        ]
        for name in ("auth", "core", "front")
    }
    if len(set(package_managers.values())) != 1:
        raise ValueError(f"Node project pnpm pins do not agree: {package_managers}")
    package_manager = package_managers["auth"]
    node_version = subprocess.run(
        ["node", "--version"], check=True, capture_output=True, text=True
    ).stdout.strip()
    pnpm_version = subprocess.run(
        ["pnpm", "--version"], check=True, capture_output=True, text=True
    ).stdout.strip()
    expected_pnpm = package_manager.removeprefix("pnpm@")
    expected_node = (repo / ".nvmrc").read_text().strip()
    if pnpm_version != expected_pnpm or node_version.removeprefix("v") != expected_node:
        raise ValueError(
            f"toolchain mismatch: expected Node {expected_node}/pnpm {expected_pnpm}, "
            f"got {node_version}/{pnpm_version}"
        )
    lock_digest = hashlib.sha256()
    for service in SERVICES.values():
        lock_digest.update(
            (repo / service["directory"] / "pnpm-lock.yaml").read_bytes()
        )
    commit = subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    return {
        "schema_version": 1,
        "record_type": "candidate_release",
        "commit_sha": commit,
        "workflow_run_id": os.environ.get("GITHUB_RUN_ID"),
        "toolchain": {
            "node": node_version,
            "pnpm": package_manager,
            "pnpm_runtime": pnpm_version,
            "pnpm_lockfiles_sha256": lock_digest.hexdigest(),
        },
        "layer": {
            "filename": "gootip-infra/rds-ca-layer.zip",
            "sha256": sha256_file(layer_path),
            "compressed_bytes": layer_compressed,
            "uncompressed_bytes": layer_uncompressed,
        },
        "previous_active_commit_sha": previous_sha,
        "changed_services": changed,
        "services": services,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--repo-root", type=Path, default=Path(__file__).resolve().parents[2]
    )
    parser.add_argument("--active-release", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        record = create_record(args.repo_root.resolve(), args.active_release)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(f"{json.dumps(record, indent=2)}\n")
    except (
        OSError,
        ValueError,
        KeyError,
        IndexError,
        TypeError,
        subprocess.CalledProcessError,
        zipfile.BadZipFile,
    ) as error:
        print(f"release artifact verification failed: {error}", file=sys.stderr)
        return 1
    print(
        f"Validated Auth/Core artifacts for {record['commit_sha']}; "
        f"changed services: {', '.join(record['changed_services']) or 'none'}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
