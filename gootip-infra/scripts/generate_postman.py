#!/usr/bin/env python3
"""Generate a Postman collection from the deployed dev HTTP API."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[2]
INFRA_ROOT = ROOT / "gootip-infra"
DEFAULT_REGION = "us-east-2"
AWS_PROFILE = "gootip-terraform-deploy"
OUTPUT = ROOT / "gootip.postman_collection.json"
SERVICES = ("auth", "core")
HTTP_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"}


def validate_invocation(cwd: Path, aws_profile: str | None) -> None:
    if cwd.resolve() != INFRA_ROOT.resolve():
        raise RuntimeError(
            "Run this command only from gootip-infra/ after loading its direnv environment."
        )
    if aws_profile != AWS_PROFILE:
        raise RuntimeError(
            f"Expected inherited AWS_PROFILE={AWS_PROFILE}; restore the existing infra session and retry."
        )


def terraform_api_url() -> str:
    try:
        result = subprocess.run(
            ["terraform", "output", "-raw", "api_url"],
            capture_output=True,
            text=True,
            timeout=60,
            cwd=INFRA_ROOT,
        )
    except FileNotFoundError as error:
        raise RuntimeError("Terraform CLI is unavailable; install Terraform and retry.") from error
    except subprocess.SubprocessError as error:
        raise RuntimeError(
            "Terraform could not read api_url; verify the initialized infra backend and active AWS session."
        ) from error
    if result.returncode != 0:
        raise RuntimeError(
            "Terraform could not read api_url; verify the initialized infra backend and active AWS session."
        )
    origin = result.stdout.strip()
    if not origin or origin.lower() == "null":
        raise RuntimeError("Terraform output api_url is missing or null; no API was selected.")
    return origin


def parse_api_origin(origin: str) -> tuple[str, str, str]:
    try:
        parsed = urlsplit(origin)
        host = parsed.hostname
        port = parsed.port
    except ValueError as error:
        raise RuntimeError("Terraform output api_url is malformed.") from error
    match = re.fullmatch(
        r"([a-z0-9]+)\.execute-api\.([a-z0-9-]+)\.amazonaws\.com",
        host or "",
    )
    if (
        parsed.scheme != "https"
        or not match
        or port is not None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError(
            "Terraform output api_url must be an HTTPS API Gateway execute-api origin."
        )
    api_id, region = match.groups()
    if region != DEFAULT_REGION:
        raise RuntimeError(
            f"Terraform output api_url must target project Region {DEFAULT_REGION}."
        )
    return api_id, region, f"https://{host}"


def run_aws(
    region: str,
    service: str,
    operation: str,
    **parameters: str | bool,
) -> dict[str, Any]:
    command = ["aws", service, operation]
    for key, value in parameters.items():
        if isinstance(value, bool):
            if value:
                command.append(f"--{key.replace('_', '-')}")
        elif value:
            command.extend((f"--{key.replace('_', '-')}", value))
    command.extend(("--region", region, "--output", "json"))
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            check=True,
            text=True,
            timeout=60,
            cwd=INFRA_ROOT,
        )
        result = json.loads(completed.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        raise RuntimeError(
            f"AWS CLI {service} {operation} failed; verify the active MFA-backed session for AWS_PROFILE={AWS_PROFILE}."
        ) from error
    if not isinstance(result, dict):
        raise RuntimeError(f"AWS CLI {service} {operation} returned invalid JSON.")
    return result


def list_aws_items(
    region: str,
    service: str,
    operation: str,
    item_keys: tuple[str, ...],
    **parameters: str,
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    token: str | None = None
    seen_tokens: set[str] = set()
    while True:
        response = run_aws(
            region,
            service,
            operation,
            **parameters,
            no_paginate=True,
            **({"next_token": token} if token else {}),
        )
        page = next((response.get(key) for key in item_keys if key in response), None)
        if not isinstance(page, list):
            raise RuntimeError(f"AWS CLI {service} {operation} response has no item list.")
        if not all(isinstance(item, dict) for item in page):
            raise RuntimeError(f"AWS CLI {service} {operation} returned an invalid item.")
        items.extend(page)
        token = response.get("NextToken") or response.get("nextToken")
        if not token:
            return items
        if not isinstance(token, str) or token in seen_tokens:
            raise RuntimeError(f"AWS CLI {service} {operation} returned an invalid pagination token.")
        seen_tokens.add(token)


def discover_gateway(
    api_id: str, region: str, expected_origin: str
) -> tuple[str, list[dict[str, Any]], list[dict[str, Any]]]:
    api = run_aws(region, "apigatewayv2", "get-api", api_id=api_id)
    if api.get("ProtocolType") != "HTTP":
        raise RuntimeError("The selected API is not an API Gateway HTTP API.")
    if api.get("DisableExecuteApiEndpoint") is True:
        raise RuntimeError("The API execute-api endpoint is disabled.")
    origin = api.get("ApiEndpoint")
    if not isinstance(origin, str) or not origin.startswith("https://"):
        raise RuntimeError("The API has no enabled HTTPS execute-api endpoint.")
    if origin.rstrip("/") != expected_origin:
        raise RuntimeError("The live API endpoint does not match Terraform output api_url.")

    stages = list_aws_items(
        region, "apigatewayv2", "get-stages", ("Items", "Stages"), api_id=api_id
    )
    if not any(stage.get("StageName") == "$default" for stage in stages):
        raise RuntimeError("The selected API has no existing $default stage.")
    routes = list_aws_items(
        region, "apigatewayv2", "get-routes", ("Items", "Routes"), api_id=api_id
    )
    integrations = list_aws_items(
        region,
        "apigatewayv2",
        "get-integrations",
        ("Items", "Integrations"),
        api_id=api_id,
    )
    return origin.rstrip("/"), routes, integrations


def lambda_function_name(uri: str) -> str | None:
    match = re.search(r":function:([^/]+)(?:/|$)", uri)
    return match.group(1).split(":", 1)[0] if match else None


def integration_services(
    integrations: list[dict[str, Any]], region: str
) -> dict[str, str]:
    result: dict[str, str] = {}
    for integration in sorted(integrations, key=lambda item: str(item.get("IntegrationId", ""))):
        integration_id = integration.get("IntegrationId")
        uri = integration.get("IntegrationUri")
        if not isinstance(integration_id, str) or not isinstance(uri, str):
            continue
        function = lambda_function_name(uri)
        if not function:
            print(f"Warning: excluding non-Lambda integration {integration_id}.", file=sys.stderr)
            continue
        service = next((name for name in SERVICES if function.endswith(f"-{name}-dev")), None)
        if not service:
            print(f"Warning: excluding unrelated Lambda integration {function}.", file=sys.stderr)
            continue
        configuration = run_aws(
            region,
            "lambda",
            "get-function-configuration",
            function_name=function,
        )
        local_zip = ROOT / f"gootip-{service}" / "lambda.zip"
        if not local_zip.is_file():
            raise RuntimeError(f"Local {service} Lambda artifact is missing; cannot check deployed version.")
        local_hash = base64.b64encode(hashlib.sha256(local_zip.read_bytes()).digest()).decode()
        if configuration.get("CodeSha256") != local_hash:
            raise RuntimeError(
                f"Local {service} Lambda artifact does not match the deployed function; regenerate contracts from the matching version."
            )
        result[integration_id] = service
    return result


def discover_operations(
    routes: list[dict[str, Any]],
    integrations: list[dict[str, Any]],
    services_by_integration: dict[str, str],
    contracts: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    integration_ids = {
        item.get("IntegrationId"): item
        for item in integrations
        if isinstance(item.get("IntegrationId"), str)
    }
    service_routes: dict[str, list[dict[str, Any]]] = {service: [] for service in SERVICES}
    for route in routes:
        target = route.get("Target", "")
        integration_id = target.removeprefix("integrations/") if isinstance(target, str) else ""
        integration = integration_ids.get(integration_id)
        service = services_by_integration.get(integration_id)
        if integration_id and not integration:
            raise RuntimeError(
                f"API Gateway route {route.get('RouteKey', '<unknown>')} references an integration missing from the AWS response."
            )
        if not service:
            if integration:
                print(
                    f"Warning: excluding route {route.get('RouteKey', '<unknown>')} targeting an unrelated integration.",
                    file=sys.stderr,
                )
            continue
        route_key = route.get("RouteKey")
        if not isinstance(route_key, str):
            raise RuntimeError("An exposed service route has no RouteKey.")
        if route_key == "$default":
            method, path = "ANY", "/{proxy+}"
        else:
            method, separator, path = route_key.partition(" ")
            if not separator:
                raise RuntimeError(f"Invalid API Gateway route key: {route_key}")
        service_routes[service].append(
            {
                "method": method,
                "path": path,
                "authorization": route.get("AuthorizationType"),
            }
        )
    for routes_for_service in service_routes.values():
        routes_for_service.sort(
            key=lambda route: (
                route["path"],
                route["method"],
                str(route.get("authorization", "")),
            )
        )

    if not any(service_routes.values()):
        raise RuntimeError("Neither Auth nor Core has an exportable deployed API Gateway route.")
    for service in SERVICES:
        if not service_routes[service]:
            print(f"Warning: no deployed {service.title()} routes; exporting the other service only.", file=sys.stderr)

    operations: dict[tuple[str, str, str], dict[str, Any]] = {}
    matched_routes: set[tuple[str, int]] = set()
    ordered_contracts = sorted(
        contracts,
        key=lambda contract: (
            str(contract.get("service", "")),
            str(contract.get("method", "")),
            str(contract.get("path", "")),
            json.dumps(contract, sort_keys=True, separators=(",", ":")),
        ),
    )
    for contract in ordered_contracts:
        service = contract.get("service")
        method = contract.get("method")
        path = contract.get("path")
        if service not in SERVICES or method not in HTTP_METHODS or not isinstance(path, str):
            raise RuntimeError("A local contract has an invalid service, HTTP method, or path.")
        if service == "auth" and (not path.startswith("/api/auth/") or method not in {"GET", "POST"}):
            # Hono's auth proxy only handles GET/POST; explicit Hono endpoints are handled above.
            if path not in {"/health", "/.well-known/openid-configuration"}:
                continue
        matched = [
            (index, route)
            for index, route in enumerate(service_routes[service])
            if route_matches(route["method"], route["path"], method, path)
        ]
        if not matched:
            continue
        key = (service, method, normalized_path(path))
        operation = operations.setdefault(key, dict(contract))
        operation["gateway_jwt"] = any(route.get("authorization") == "JWT" for _, route in matched)
        matched_routes.update((service, index) for index, _ in matched)

    for service in SERVICES:
        for index, route in enumerate(service_routes[service]):
            if (service, index) in matched_routes:
                continue
            if service == "auth" and route["path"] == "/api/auth":
                continue
            raise RuntimeError(
                f"Exposed {service} route {route['method']} {route['path']} could not be resolved from local contracts."
            )
    if not operations:
        raise RuntimeError("No deployed routes matched locally resolved application operations.")
    return list(operations.values())


def route_matches(route_method: str, route_path: str, method: str, path: str) -> bool:
    if route_method not in {"ANY", method}:
        return False
    pattern = re.escape(route_path)
    pattern = re.sub(r"\\\{[^/]+\\\+\\\}", r".+", pattern)
    pattern = re.sub(r"\\\{[^/]+\\\}", r"[^/]+", pattern)
    pattern = re.sub(r":([A-Za-z_][A-Za-z0-9_]*)", r"[^/]+", pattern)
    return re.fullmatch(pattern, path) is not None


def normalized_path(path: str) -> str:
    normalized = re.sub(
        r":([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\}",
        "{}",
        path,
    )
    return normalized.rstrip("/") or "/"


def run_exporter(service: str) -> list[dict[str, Any]]:
    package = ROOT / f"gootip-{service}"
    try:
        completed = subprocess.run(
            ["pnpm", "exec", "tsx", "scripts/export-contracts.ts"],
            cwd=package,
            capture_output=True,
            check=True,
            text=True,
            timeout=120,
        )
        contracts = json.loads(completed.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        raise RuntimeError(
            f"Could not extract {service} contracts; install its Node dependencies and check the exporter."
        ) from error
    if not isinstance(contracts, list):
        raise RuntimeError(f"The {service} contract exporter returned invalid JSON.")
    return contracts


def postman_path(contract: dict[str, Any]) -> str:
    path = contract["path"]
    parameters = contract.get("parameters", {})
    for name, parameter in parameters.items():
        example = parameter.get("example")
        path = path.replace(f":{name}", str(example)).replace(f"{{{name}}}", str(example))
    if any(token in path for token in ("*", "{proxy+}", ":")):
        raise RuntimeError(f"Unresolved wildcard or path parameter in local contract: {path}")
    return path


def _example(field: dict[str, Any]) -> Any:
    if field.get("type") == "object" and isinstance(field.get("fields"), dict):
        return {
            name: _example(field["fields"][name])
            for name in sorted(field["fields"])
        }
    return field.get("example")


def _examples(schema: dict[str, Any] | None) -> dict[str, Any]:
    return {name: _example(schema[name]) for name in sorted(schema or {})}


def postman_request(operation: dict[str, Any]) -> dict[str, Any]:
    method = operation["method"]
    path = postman_path(operation)
    request: dict[str, Any] = {
        "name": f"{method} {path}",
        "request": {
            "method": method,
            "header": [],
            "url": {
                "raw": "{{baseUrl}}" + path,
                "host": ["{{baseUrl}}"],
                "path": [segment for segment in path.strip("/").split("/") if segment],
            },
            "description": "Illustrative request. Replace example credentials or related-record IDs before sending.",
        },
    }
    query = operation.get("query", {})
    if query:
        request["request"]["url"]["query"] = [
            {
                "key": name,
                "value": str(field.get("example", "")),
                "disabled": not field.get("required", False),
            }
            for name, field in sorted(query.items())
        ]
    body = operation.get("body")
    if body:
        request["request"]["header"].append(
            {"key": "Content-Type", "value": "application/json"}
        )
        request["request"]["body"] = {
            "mode": "raw",
            "raw": json.dumps(_examples(body), indent=2, sort_keys=True),
            "options": {"raw": {"language": "json"}},
        }
        if any(name.lower() in {"password", "email"} for name in body):
            request["request"]["description"] = (
                "Illustrative request. Replace email/password with test credentials before sending."
            )
        if any(name.lower().endswith("id") for name in body):
            request["request"]["description"] += " Related-record IDs may need to exist."
    if operation.get("gateway_jwt"):
        request["request"]["auth"] = {
            "type": "bearer",
            "bearer": [{"key": "token", "value": "{{bearerToken}}", "type": "string"}],
        }
    return request


def build_collection(
    origin: str,
    operations: list[dict[str, Any]],
) -> dict[str, Any]:
    folders = []
    for service in SERVICES:
        requests = [
            postman_request(operation)
            for operation in sorted(
                operations,
                key=lambda item: (
                    item["path"],
                    item["method"],
                    json.dumps(item, sort_keys=True, separators=(",", ":")),
                ),
            )
            if operation["service"] == service
        ]
        if requests:
            folders.append({"name": service.title(), "item": requests})
    return {
        "info": {
            "name": "Gootip API",
            "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
            "description": "Illustrative requests only. Auth requirements are enforced by the application; JWT authorization is included only where API Gateway configures it.",
        },
        "item": folders,
        "variable": [
            {"key": "baseUrl", "value": origin, "type": "string"},
            {"key": "bearerToken", "value": "", "type": "string"},
        ],
    }


def serialize_collection(collection: dict[str, Any]) -> str:
    return json.dumps(collection, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def write_collection(collection: dict[str, Any], output: Path = OUTPUT) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{output.name}.", suffix=".tmp", dir=output.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(serialize_collection(collection))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, output)
    finally:
        if temporary.exists():
            temporary.unlink()


def generate(api_id: str, region: str, expected_origin: str) -> dict[str, Any]:
    origin, routes, integrations = discover_gateway(api_id, region, expected_origin)
    services_by_integration = integration_services(integrations, region)
    contracts = [
        *run_exporter("auth"),
        *run_exporter("core"),
    ]
    operations = discover_operations(routes, integrations, services_by_integration, contracts)
    return build_collection(origin, operations)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        epilog="Run without arguments from gootip-infra/ after loading its MFA-backed AWS session.",
    )
    parser.parse_args(argv)
    try:
        validate_invocation(Path.cwd(), os.environ.get("AWS_PROFILE"))
        api_id, region, origin = parse_api_origin(terraform_api_url())
        collection = generate(api_id, region, origin)
        write_collection(collection)
    except (RuntimeError, OSError) as error:
        parser.error(str(error))
    print(f"Generated {OUTPUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
