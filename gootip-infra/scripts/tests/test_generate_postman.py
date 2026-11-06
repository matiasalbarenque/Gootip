from __future__ import annotations

import base64
import hashlib
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import generate_postman as generator


class InvocationTests(unittest.TestCase):
    def test_requires_infra_directory_and_exact_inherited_profile(self):
        generator.validate_invocation(generator.INFRA_ROOT, generator.AWS_PROFILE)
        with self.assertRaisesRegex(RuntimeError, "only from gootip-infra"):
            generator.validate_invocation(Path("/tmp"), generator.AWS_PROFILE)
        with self.assertRaisesRegex(RuntimeError, "Expected inherited AWS_PROFILE"):
            generator.validate_invocation(generator.INFRA_ROOT, "default")

    def test_resolves_api_identity_only_from_execute_api_origin_in_project_region(self):
        self.assertEqual(
            generator.parse_api_origin(
                "https://abc123.execute-api.us-east-2.amazonaws.com/"
            ),
            (
                "abc123",
                "us-east-2",
                "https://abc123.execute-api.us-east-2.amazonaws.com",
            ),
        )
        for invalid in (
            "null",
            "https://api.example.test",
            "http://abc123.execute-api.us-east-2.amazonaws.com",
            "https://abc123.execute-api.us-west-2.amazonaws.com",
            "https://abc123.execute-api.us-east-2.amazonaws.com/custom",
        ):
            with self.subTest(invalid=invalid), self.assertRaises(RuntimeError):
                generator.parse_api_origin(invalid)

    def test_terraform_output_uses_existing_infra_directory_and_inherited_environment(self):
        completed = generator.subprocess.CompletedProcess(
            [], 0, "https://abc123.execute-api.us-east-2.amazonaws.com\n", ""
        )
        with patch.object(generator.subprocess, "run", return_value=completed) as run:
            output = generator.terraform_api_url()
        self.assertEqual(output, "https://abc123.execute-api.us-east-2.amazonaws.com")
        self.assertEqual(run.call_args.args[0], ["terraform", "output", "-raw", "api_url"])
        self.assertEqual(run.call_args.kwargs["cwd"], generator.INFRA_ROOT)
        self.assertNotIn("env", run.call_args.kwargs)

    def test_terraform_output_fails_actionably_without_initializing_or_falling_back(self):
        with patch.object(generator.subprocess, "run", side_effect=FileNotFoundError):
            with self.assertRaisesRegex(RuntimeError, "Terraform CLI is unavailable"):
                generator.terraform_api_url()
        failed = generator.subprocess.CompletedProcess([], 1, "", "backend not initialized")
        with patch.object(generator.subprocess, "run", return_value=failed):
            with self.assertRaisesRegex(RuntimeError, "initialized infra backend"):
                generator.terraform_api_url()
        null = generator.subprocess.CompletedProcess([], 0, "null\n", "")
        with patch.object(generator.subprocess, "run", return_value=null):
            with self.assertRaisesRegex(RuntimeError, "missing or null"):
                generator.terraform_api_url()

    def test_terraform_failure_does_not_replace_existing_collection(self):
        with (
            patch.object(generator.Path, "cwd", return_value=generator.INFRA_ROOT),
            patch.dict(generator.os.environ, {"AWS_PROFILE": generator.AWS_PROFILE}),
            patch.object(
                generator,
                "terraform_api_url",
                side_effect=RuntimeError("Terraform backend is unavailable"),
            ),
            patch.object(generator, "write_collection") as write,
        ):
            with self.assertRaises(SystemExit):
                generator.main([])
        write.assert_not_called()

    def test_parameterless_main_checks_context_before_external_reads_or_writes(self):
        with (
            patch.object(generator.Path, "cwd", return_value=Path("/tmp")),
            patch.dict(generator.os.environ, {"AWS_PROFILE": generator.AWS_PROFILE}),
            patch.object(generator.subprocess, "run") as run,
            patch.object(generator, "write_collection") as write,
        ):
            with self.assertRaises(SystemExit):
                generator.main([])
        run.assert_not_called()
        write.assert_not_called()

        with (
            patch.object(generator.Path, "cwd", return_value=generator.INFRA_ROOT),
            patch.dict(generator.os.environ, {"AWS_PROFILE": "default"}),
            patch.object(generator.subprocess, "run") as run,
            patch.object(generator, "write_collection") as write,
        ):
            with self.assertRaises(SystemExit):
                generator.main([])
        run.assert_not_called()
        write.assert_not_called()

    def test_parameterless_main_derives_api_id_and_region_then_writes_workspace_output(self):
        with (
            patch.object(generator.Path, "cwd", return_value=generator.INFRA_ROOT),
            patch.dict(generator.os.environ, {"AWS_PROFILE": generator.AWS_PROFILE}),
            patch.object(
                generator,
                "terraform_api_url",
                return_value="https://abc123.execute-api.us-east-2.amazonaws.com",
            ),
            patch.object(generator, "generate", return_value={"item": []}) as generate,
            patch.object(generator, "write_collection") as write,
        ):
            self.assertEqual(generator.main([]), 0)
        generate.assert_called_once_with(
            "abc123",
            "us-east-2",
            "https://abc123.execute-api.us-east-2.amazonaws.com",
        )
        write.assert_called_once_with({"item": []})

    def test_rejects_configuration_arguments_before_external_reads(self):
        for arguments in (
            ["--api-id", "manual-id"],
            ["--profile", "manual-profile"],
            ["--region", "us-west-2"],
            ["manual-id"],
        ):
            with self.subTest(arguments=arguments), patch.object(
                generator.subprocess, "run"
            ) as run:
                with self.assertRaises(SystemExit):
                    generator.main(arguments)
                run.assert_not_called()

    def test_help_does_not_start_external_commands(self):
        with patch.object(generator.subprocess, "run") as run:
            with self.assertRaises(SystemExit) as exit_info:
                generator.main(["--help"])
        self.assertEqual(exit_info.exception.code, 0)
        run.assert_not_called()


class AwsDiscoveryTests(unittest.TestCase):
    def test_aws_call_uses_inherited_session_without_profile_override(self):
        completed = generator.subprocess.CompletedProcess([], 0, "{}", "")
        with patch.object(generator.subprocess, "run", return_value=completed) as run:
            generator.run_aws(
                "us-east-2",
                "apigatewayv2",
                "get-routes",
                api_id="api-123",
                no_paginate=True,
                next_token="next-page",
            )
        command = run.call_args.args[0]
        self.assertIn("--no-paginate", command)
        self.assertIn("--next-token", command)
        self.assertIn("us-east-2", command)
        self.assertNotIn("--profile", command)
        self.assertEqual(run.call_args.kwargs["cwd"], generator.INFRA_ROOT)

    def test_reads_all_pages_with_explicit_cli_pagination(self):
        with patch.object(
            generator,
            "run_aws",
            side_effect=[
                {"Items": [{"RouteKey": "GET /first"}], "NextToken": "page-2"},
                {"Items": [{"RouteKey": "GET /second"}]},
            ],
        ) as run:
            items = generator.list_aws_items(
                "us-east-2",
                "apigatewayv2",
                "get-routes",
                ("Items", "Routes"),
                api_id="api-123",
            )

        self.assertEqual([item["RouteKey"] for item in items], ["GET /first", "GET /second"])
        self.assertEqual(run.call_args_list[0].kwargs["no_paginate"], True)
        self.assertEqual(run.call_args_list[1].kwargs["next_token"], "page-2")

    def test_checks_http_api_endpoint_and_default_stage(self):
        pages = {
            "get-api": {"ProtocolType": "HTTP", "ApiEndpoint": "https://api.example.test"},
            "get-stages": {"Items": [{"StageName": "$default"}]},
            "get-routes": {"Items": []},
            "get-integrations": {"Items": []},
        }
        pages["get-api"]["ApiEndpoint"] = "https://api-123.execute-api.us-east-2.amazonaws.com"
        with patch.object(generator, "run_aws", side_effect=lambda *_args, **kwargs: pages[_args[2]]):
            origin, routes, integrations = generator.discover_gateway(
                "api-123",
                "us-east-2",
                "https://api-123.execute-api.us-east-2.amazonaws.com",
            )
        self.assertEqual(origin, "https://api-123.execute-api.us-east-2.amazonaws.com")
        self.assertEqual((routes, integrations), ([], []))

        with patch.object(
            generator,
            "run_aws",
            return_value={"ProtocolType": "REST", "ApiEndpoint": "https://api-123.execute-api.us-east-2.amazonaws.com"},
        ):
            with self.assertRaisesRegex(RuntimeError, "HTTP API"):
                generator.discover_gateway(
                    "api-123",
                    "us-east-2",
                    "https://api-123.execute-api.us-east-2.amazonaws.com",
                )

        with patch.object(
            generator,
            "run_aws",
            return_value={
                "ProtocolType": "HTTP",
                "ApiEndpoint": "https://other.execute-api.us-east-2.amazonaws.com",
            },
        ):
            with self.assertRaisesRegex(RuntimeError, "does not match Terraform"):
                generator.discover_gateway(
                    "api-123",
                    "us-east-2",
                    "https://api-123.execute-api.us-east-2.amazonaws.com",
                )

    def test_matches_lambda_function_name_and_local_artifact_version(self):
        self.assertEqual(
            generator.lambda_function_name(
                "arn:aws:lambda:us-east-2:123456789012:function:gootip-auth-dev/invocations"
            ),
            "gootip-auth-dev",
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = b"local zip artifact"
            (root / "gootip-auth").mkdir()
            (root / "gootip-auth" / "lambda.zip").write_bytes(archive)
            expected = base64.b64encode(hashlib.sha256(archive).digest()).decode()
            with (
                patch.object(generator, "ROOT", root),
                patch.object(
                    generator,
                    "run_aws",
                    return_value={"CodeSha256": expected},
                ),
            ):
                services = generator.integration_services(
                    [
                        {
                            "IntegrationId": "int-auth",
                            "IntegrationUri": "arn:aws:lambda:us-east-2:123456789012:function:gootip-auth-dev/invocations",
                        }
                    ],
                    "us-east-2",
                )
            self.assertEqual(services, {"int-auth": "auth"})


class RouteAndCollectionTests(unittest.TestCase):
    def test_matches_concrete_and_proxy_gateway_routes(self):
        self.assertTrue(generator.route_matches("GET", "/api/categories/{id}", "GET", "/api/categories/:id"))
        self.assertTrue(generator.route_matches("ANY", "/api/auth/{proxy+}", "POST", "/api/auth/sign-in/email"))
        self.assertFalse(generator.route_matches("GET", "/api/categories", "POST", "/api/categories"))

    def test_exports_only_operations_covered_by_their_target_service(self):
        integrations = [
            {"IntegrationId": "auth", "IntegrationUri": "arn:lambda:auth"},
            {"IntegrationId": "core", "IntegrationUri": "arn:lambda:core"},
        ]
        routes = [
            {"RouteKey": "ANY /api/auth", "Target": "integrations/auth"},
            {"RouteKey": "ANY /api/auth/{proxy+}", "Target": "integrations/auth"},
            {"RouteKey": "GET /.well-known/openid-configuration", "Target": "integrations/auth"},
            {"RouteKey": "GET /api/categories/{id}", "Target": "integrations/core", "AuthorizationType": "JWT"},
        ]
        contracts = [
            {"service": "auth", "method": "POST", "path": "/api/auth/sign-in/email", "body": {}},
            {"service": "auth", "method": "GET", "path": "/.well-known/openid-configuration"},
            {"service": "core", "method": "GET", "path": "/api/categories/:id", "parameters": {"id": {"example": "00000000-0000-4000-8000-000000000001"}}},
        ]
        operations = generator.discover_operations(
            routes,
            integrations,
            {"auth": "auth", "core": "core"},
            contracts,
        )
        collection = generator.build_collection("https://api.example.test", operations)
        folders = {item["name"]: item["item"] for item in collection["item"]}
        request = next(item["request"] for item in folders["Core"])
        self.assertEqual(request["method"], "GET")
        self.assertIn("00000000-0000-4000-8000-000000000001", request["url"]["raw"])
        self.assertEqual(request["auth"]["bearer"][0]["value"], "{{bearerToken}}")
        self.assertNotIn("ANY", str(collection))

    def test_fails_for_unresolved_exposed_service_routes(self):
        with self.assertRaisesRegex(RuntimeError, "could not be resolved"):
            generator.discover_operations(
                [{"RouteKey": "GET /api/missing", "Target": "integrations/core"}],
                [{"IntegrationId": "core"}],
                {"core": "core"},
                [],
            )

    def test_generates_json_body_and_disables_optional_filters(self):
        request = generator.postman_request(
            {
                "service": "core",
                "method": "POST",
                "path": "/api/products",
                "body": {
                    "categoryId": {"type": "string", "example": "fake-id"},
                    "name": {"type": "string", "example": "sample"},
                },
                "query": {
                    "page": {"type": "number", "required": True, "example": 1},
                    "search": {"type": "string", "required": False, "example": "sample"},
                },
            }
        )["request"]
        self.assertIn({"key": "Content-Type", "value": "application/json"}, request["header"])
        self.assertEqual(request["url"]["query"][0]["disabled"], False)
        self.assertEqual(request["url"]["query"][1]["disabled"], True)
        self.assertIn("fake-id", request["body"]["raw"])
        self.assertIn("Related-record IDs", request["description"])

    def test_generate_combines_mocked_aws_and_exporter_responses(self):
        responses = {
            "get-api": {"ProtocolType": "HTTP", "ApiEndpoint": "https://api.example.test"},
            "get-stages": {"Items": [{"StageName": "$default"}]},
            "get-routes": {
                "Items": [
                    {"RouteKey": "ANY /api/auth/{proxy+}", "Target": "integrations/auth"},
                    {"RouteKey": "GET /api/health", "Target": "integrations/core"},
                ]
            },
            "get-integrations": {
                "Items": [
                    {"IntegrationId": "auth", "IntegrationUri": "arn:lambda:auth"},
                    {"IntegrationId": "core", "IntegrationUri": "arn:lambda:core"},
                ]
            },
        }
        contracts = {
            "auth": [
                {
                    "service": "auth",
                    "method": "POST",
                    "path": "/api/auth/sign-in/email",
                    "body": {"email": {"type": "string", "example": "user@example.invalid"}},
                }
            ],
            "core": [
                {"service": "core", "method": "GET", "path": "/api/health"}
            ],
        }
        with (
            patch.object(
                generator,
                "run_aws",
                side_effect=lambda *_args, **kwargs: responses[_args[2]],
            ),
            patch.object(generator, "integration_services", return_value={"auth": "auth", "core": "core"}),
            patch.object(generator, "run_exporter", side_effect=lambda service: contracts[service]),
        ):
            collection = generator.generate(
                "api-123",
                "us-east-2",
                "https://api.example.test",
            )

        self.assertEqual(collection["variable"][0]["value"], "https://api.example.test")
        self.assertEqual([folder["name"] for folder in collection["item"]], ["Auth", "Core"])

    def test_collection_bytes_are_stable_when_input_order_changes(self):
        operations = [
            {
                "service": "core",
                "method": "POST",
                "path": "/api/products",
                "body": {
                    "name": {"example": "sample", "type": "string"},
                    "sku": {"example": "SKU-EXAMPLE", "type": "string"},
                },
            },
            {
                "service": "auth",
                "method": "GET",
                "path": "/api/auth/get-session",
                "query": {
                    "zFilter": {"example": "z", "required": False},
                    "aFilter": {"example": "a", "required": False},
                },
            },
        ]
        first = generator.serialize_collection(
            generator.build_collection("https://api.example.test", operations)
        )
        second = generator.serialize_collection(
            generator.build_collection("https://api.example.test", list(reversed(operations)))
        )
        self.assertEqual(first.encode(), second.encode())

    def test_atomic_output_keeps_previous_file_when_replacement_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "collection.json"
            output.write_bytes(b"previous collection\n")
            with patch.object(generator.os, "replace", side_effect=OSError("disk failure")):
                with self.assertRaisesRegex(OSError, "disk failure"):
                    generator.write_collection({"info": {"name": "new"}}, output)
            self.assertEqual(output.read_bytes(), b"previous collection\n")
            self.assertEqual(list(output.parent.iterdir()), [output])


if __name__ == "__main__":
    unittest.main()
