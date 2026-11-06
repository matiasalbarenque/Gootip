"""Exercise the exact documented probe without AWS or PostgreSQL access."""

import contextlib
import io
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import credential_rotation_live as live


class CredentialFunctionDiagnosticTests(unittest.TestCase):
    def test_documented_probe_uses_operator_discovery_and_master_secret_only(self):
        document = (Path(__file__).resolve().parents[2]
                    / "docs/credential-function-diagnostic.md").read_text()
        source = document.split("```python\n", 1)[1].split("```", 1)[0]
        session = Mock()
        session.client.return_value.get_secret_value.return_value = {
            "ARN": "arn:aws:secretsmanager:us-east-2:123456789012:secret:rds!db-00000000-0000-4000-8000-000000000000",
            "SecretString": json.dumps({"username": "gootip_auth", "password": "fictional-master"}),
        }
        cursor = Mock()
        cursor.fetchone.return_value = {"session": {
            "user": "gootip_auth", "database": "gootip", "ssl": True,
            "tls_version": "TLSv1.3",
        }, "settings": {}, "extensions": []},
        connection = Mock()
        connection.cursor.return_value = contextlib.nullcontext(cursor)
        rolled_back = []

        @contextlib.contextmanager
        def transaction():
            try:
                yield
            except Exception:
                rolled_back.append(True)
                raise

        connection.transaction.side_effect = transaction
        discovery = SimpleNamespace(stdout="Certificate hostname: gootip-dev.example.us-east-2.rds.amazonaws.com\n")
        output = io.StringIO()
        with patch.dict(sys.modules, {
            "boto3": SimpleNamespace(Session=Mock(return_value=session)),
            "psycopg": SimpleNamespace(Error=type("DatabaseError", (Exception,), {})),
        }), patch("subprocess.run", return_value=discovery) as run, \
                patch.object(live, "_db_connect", return_value=connection) as connect, \
                patch.object(live, "validate_logging_settings"), \
                contextlib.redirect_stdout(output):
            exec(compile(source, "documented_probe", "exec"), {})
        session.client.assert_called_once_with("secretsmanager")
        self.assertEqual(run.call_args.args[0], ["bash", "gootip-infra/scripts/db_access.sh", "info"])
        connect.assert_called_once_with("gootip-dev.example.us-east-2.rds.amazonaws.com", "gootip_auth", "fictional-master")
        self.assertEqual(rolled_back, [True])
        self.assertEqual(json.loads(output.getvalue())["outcome"], "function_succeeded_transaction_rolled_back")
        self.assertNotIn("fictional-master", output.getvalue())
        connection.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
