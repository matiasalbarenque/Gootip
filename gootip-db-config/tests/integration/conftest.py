"""Guarded fixtures for the shared PostgreSQL integration database."""

from __future__ import annotations

import contextlib
import dataclasses
import json
import os
from collections.abc import Iterator
from dataclasses import dataclass

import psycopg
import pytest
from psycopg import sql

from gootip_db_config import handler
from gootip_db_config.config import Config, load_config
from gootip_db_config.credentials import Credentials

DATABASE = "gootip_test_db_config"
MASTER_USER = "test_db_config_master"
RUNTIME_USER = "test_db_config_runtime"
MIGRATOR_USER = "test_db_config_migrator"
OPERATOR_USER = "test_db_config_operator"
CORE_RUNTIME_USER = "test_db_config_core_runtime"
CORE_MIGRATOR_USER = "test_db_config_core_migrator"
ROLE_NAMES = (
    MASTER_USER,
    RUNTIME_USER,
    MIGRATOR_USER,
    OPERATOR_USER,
    CORE_RUNTIME_USER,
    CORE_MIGRATOR_USER,
)
ADDITIONAL_DATABASES = (
    "gootip_test_db_config_operator_window",
    "gootip_test_db_config_membership",
    "gootip_test_db_config_admin_membership",
    "gootip_test_db_config_bookkeeping",
    "gootip_test_db_config_concurrency",
)
OWNED_DATABASES = (DATABASE, *ADDITIONAL_DATABASES)
_SECRET_ARN = "arn:aws:secretsmanager:us-east-2:123456789012:secret:"


def _required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        pytest.fail(
            f"{name} is required; run gootip-infra/scripts/local_postgres.sh integration",
            pytrace=False,
        )
    return value


@dataclass(frozen=True)
class SharedPostgres:
    """Connection details for the local shared PostgreSQL service."""

    host: str
    port: int
    admin_user: str
    admin_password: str

    def connect(self, *, dbname: str, user: str, password: str) -> psycopg.Connection:
        connection = psycopg.connect(
            host=self.host,
            port=self.port,
            dbname=dbname,
            user=user,
            password=password,
            connect_timeout=5,
            sslmode="disable",
        )
        connection.autocommit = True
        return connection


def _admin(server: SharedPostgres) -> psycopg.Connection:
    return server.connect(
        dbname="postgres",
        user=server.admin_user,
        password=server.admin_password,
    )


def _drop_owned_resources(server: SharedPostgres) -> None:
    with _admin(server) as connection:
        for database in OWNED_DATABASES:
            connection.execute(
                sql.SQL("DROP DATABASE IF EXISTS {}").format(sql.Identifier(database))
            )
        for role in ROLE_NAMES:
            connection.execute(sql.SQL("DROP ROLE IF EXISTS {}").format(sql.Identifier(role)))


def _create_owned_resources(server: SharedPostgres, master_password: str) -> None:
    with _admin(server) as connection:
        connection.execute(
            sql.SQL(
                "CREATE ROLE {} WITH LOGIN CREATEROLE NOSUPERUSER NOCREATEDB PASSWORD {}"
            ).format(sql.Identifier(MASTER_USER), sql.Literal(master_password))
        )
        connection.execute(
            sql.SQL("CREATE DATABASE {} OWNER {}").format(
                sql.Identifier(DATABASE), sql.Identifier(MASTER_USER)
            )
        )


def _env(server: SharedPostgres, database: str) -> dict[str, str]:
    return {
        "POSTGRES_DB_HOST": server.host,
        "POSTGRES_DB_PORT": str(server.port),
        "POSTGRES_DB_NAME": database,
        "POSTGRES_SSL_MODE": "verify-full",
        "DB_MASTER_SECRET_ARN": f"{_SECRET_ARN}local-test-master",
        "AUTH_RUNTIME_SECRET_ARN": f"{_SECRET_ARN}local-test-runtime",
        "AUTH_MIGRATOR_SECRET_ARN": f"{_SECRET_ARN}local-test-migrator",
        "DB_OPERATOR_SECRET_ARN": f"{_SECRET_ARN}local-test-operator",
        "CORE_RUNTIME_SECRET_ARN": f"{_SECRET_ARN}local-test-core-runtime",
        "CORE_MIGRATOR_SECRET_ARN": f"{_SECRET_ARN}local-test-core-migrator",
    }


def _credentials(config: Config, passwords: dict[str, str]) -> dict[str, Credentials]:
    return {
        MASTER_USER: Credentials(MASTER_USER, passwords[MASTER_USER]),
        config.runtime_role: Credentials(config.runtime_role, passwords[RUNTIME_USER]),
        config.migrator_role: Credentials(config.migrator_role, passwords[MIGRATOR_USER]),
        config.operator_role: Credentials(config.operator_role, passwords[OPERATOR_USER]),
        config.core_runtime_role: Credentials(config.core_runtime_role, "unused-core-runtime"),
        config.core_migrator_role: Credentials(config.core_migrator_role, "unused-core-migrator"),
    }


class Bootstrapped:
    """A test-owned database with namespaced role and secret helpers."""

    def __init__(
        self,
        server: SharedPostgres,
        env: dict[str, str],
        passwords: dict[str, str],
        first_counts: dict[str, int],
    ) -> None:
        self.server = server
        self.env = env
        self.config = dataclasses.replace(
            load_config(env),
            ssl_mode="disable",
            runtime_role=RUNTIME_USER,
            migrator_role=MIGRATOR_USER,
            operator_role=OPERATOR_USER,
            core_runtime_role=CORE_RUNTIME_USER,
            core_migrator_role=CORE_MIGRATOR_USER,
        )
        self.credentials = _credentials(self.config, passwords)
        self.passwords = passwords
        self.first_counts = first_counts
        self.master_user = MASTER_USER

    @property
    def runtime_role(self) -> str:
        return self.config.runtime_role

    @property
    def migrator_role(self) -> str:
        return self.config.migrator_role

    @property
    def operator_role(self) -> str:
        return self.config.operator_role

    def connection(self, role: str, config: Config | None = None) -> psycopg.Connection:
        target = config or self.config
        return self.server.connect(
            dbname=target.db_name,
            user=role,
            password=self.passwords[role],
        )

    @contextlib.contextmanager
    def session(self, role: str, config: Config | None = None) -> Iterator[psycopg.Connection]:
        connection = self.connection(role, config)
        try:
            yield connection
        finally:
            connection.close()

    def superuser_connection(self) -> psycopg.Connection:
        return _admin(self.server)

    def reconcile(self, config: Config | None = None) -> dict[str, int]:
        target = config or self.config
        connection = self.connection(self.master_user, target)
        try:
            return handler._reconcile(connection, target, self.credentials)
        finally:
            connection.close()

    def reconcile_with_history(self, config: Config | None = None) -> dict[str, int]:
        target = config or self.config
        with self.session(self.migrator_role, target) as migrator:
            migrator.execute(
                "CREATE TABLE IF NOT EXISTS auth.gootip_schema_migrations "
                "(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL)"
            )
        return self.reconcile(target)

    def fresh_database(self, name: str) -> Config:
        if name not in ADDITIONAL_DATABASES:
            raise ValueError("database name is outside the db-config test allowlist")
        with _admin(self.server) as connection:
            connection.execute(
                sql.SQL("CREATE DATABASE {} OWNER {}").format(
                    sql.Identifier(name), sql.Identifier(MASTER_USER)
                )
            )
        return dataclasses.replace(self.config, db_name=name)

    def secret_map(self) -> dict[str, str]:
        return {
            self.env["DB_MASTER_SECRET_ARN"]: json.dumps(
                {"username": MASTER_USER, "password": self.passwords[MASTER_USER]}
            ),
            self.env["AUTH_RUNTIME_SECRET_ARN"]: json.dumps(
                {"username": self.runtime_role, "password": self.passwords[RUNTIME_USER]}
            ),
            self.env["AUTH_MIGRATOR_SECRET_ARN"]: json.dumps(
                {"username": self.migrator_role, "password": self.passwords[MIGRATOR_USER]}
            ),
            self.env["DB_OPERATOR_SECRET_ARN"]: json.dumps(
                {"username": self.operator_role, "password": self.passwords[OPERATOR_USER]}
            ),
            self.env["CORE_RUNTIME_SECRET_ARN"]: json.dumps(
                {"username": self.config.core_runtime_role, "password": "unused-core-runtime"}
            ),
            self.env["CORE_MIGRATOR_SECRET_ARN"]: json.dumps(
                {"username": self.config.core_migrator_role, "password": "unused-core-migrator"}
            ),
        }


@pytest.fixture(scope="session")
def postgres() -> Iterator[SharedPostgres]:
    host = _required("LOCAL_POSTGRES_HOST")
    raw_port = _required("LOCAL_POSTGRES_PORT")
    database = _required("GOOTIP_DB_CONFIG_TEST_DATABASE")
    admin_user = _required("POSTGRES_ADMIN_USER")
    admin_password = _required("POSTGRES_ADMIN_PASSWORD")

    if host != "127.0.0.1" or database != DATABASE or admin_user != "gootip_local_admin":
        pytest.fail("db-config integration target is outside its local allowlist", pytrace=False)
    try:
        port = int(raw_port)
        if not 1 <= port <= 65535:
            raise ValueError
    except ValueError:
        pytest.fail("LOCAL_POSTGRES_PORT must be a valid TCP port", pytrace=False)

    server = SharedPostgres(host, port, admin_user, admin_password)
    try:
        with _admin(server) as connection:
            connection.execute("SELECT 1")
    except psycopg.OperationalError as error:
        pytest.fail(
            f"shared PostgreSQL is unavailable at 127.0.0.1:{port}: {error}",
            pytrace=False,
        )

    yield server


@pytest.fixture(scope="session")
def bootstrapped(postgres: SharedPostgres) -> Iterator[Bootstrapped]:
    passwords = {
        MASTER_USER: _required("TEST_DB_CONFIG_MASTER_PASSWORD"),
        RUNTIME_USER: _required("TEST_DB_CONFIG_RUNTIME_PASSWORD"),
        MIGRATOR_USER: _required("TEST_DB_CONFIG_MIGRATOR_PASSWORD"),
        OPERATOR_USER: _required("TEST_DB_CONFIG_OPERATOR_PASSWORD"),
        CORE_RUNTIME_USER: "unused-core-runtime",
        CORE_MIGRATOR_USER: "unused-core-migrator",
    }
    _drop_owned_resources(postgres)
    _create_owned_resources(postgres, passwords[MASTER_USER])
    env = _env(postgres, DATABASE)
    state = Bootstrapped(
        postgres,
        env,
        passwords,
        first_counts={"roles_created": 0, "schema_created": 0},
    )
    try:
        state.first_counts = state.reconcile()
        yield state
    finally:
        _drop_owned_resources(postgres)
