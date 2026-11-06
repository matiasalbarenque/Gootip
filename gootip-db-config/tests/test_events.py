"""Fixed event contract: only the `bootstrap` operation is accepted."""

import pytest

from gootip_db_config.errors import InvalidEvent
from gootip_db_config.events import validate_event


def test_bootstrap_operation_is_accepted():
    assert validate_event({"operation": "bootstrap"}) == "bootstrap"


@pytest.mark.parametrize(
    "event",
    [
        None,
        "bootstrap",
        ["bootstrap"],
        {},
        {"operation": "drop_everything"},
        {"operation": "bootstrap", "sql": "DROP TABLE users"},
        {"operation": "bootstrap", "database": "other"},
        {"operation": "bootstrap", "role": "postgres"},
        {"operation": "bootstrap", "password": "hunter2"},
        {"operation": "bootstrap", "secret_arn": "arn:aws:secretsmanager:..."},
    ],
)
def test_events_outside_the_contract_are_rejected(event):
    with pytest.raises(InvalidEvent) as raised:
        validate_event(event)

    assert raised.value.code == "invalid_event"
