"""The same Task fixtures must survive both SDKs without losing integration facts."""

import json
from pathlib import Path

import pytest

from deepseek_harness import HarnessClient, SdkProtocolError

FIXTURES = Path(__file__).resolve().parents[3] / "scripts/snapshots/task-integration-sdk"
INVALID = json.loads((FIXTURES / "invalid.json").read_text())


def test_task_integrations_preserve_all_outcomes(monkeypatch: pytest.MonkeyPatch) -> None:
    client = HarnessClient()
    row = json.loads((FIXTURES / "task.json").read_text())

    def request(_method: str, _params: object, *, response_model: type, **_kwargs: object):
        return response_model.model_validate({"generation": 4, "tasks": [row]})

    monkeypatch.setattr(client, "request", request)
    task = client.list_tasks().tasks[0]
    assert task.model_dump(by_alias=True, exclude_none=True) == row
    assert [node.outcome.kind for node in task.integrations] == [
        "conflict", "running", "unconfirmed", "failed", "integrated", "conflict",
    ]
    assert task.integrations[0].resolved_by == task.integrations[4].id
    assert task.integrations[5].resolved_by is None


@pytest.mark.parametrize("case", INVALID, ids=[case["name"] for case in INVALID])
def test_task_integrations_reject_malformed_wire_values(case: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    client = HarnessClient()
    row = json.loads((FIXTURES / "task.json").read_text())
    keys = case["path"].split("/")
    target = row
    for key in keys[:-1]:
        target = target[int(key)] if isinstance(target, list) else target[key]
    key = int(keys[-1]) if isinstance(target, list) else keys[-1]
    target[key] = case["value"]

    def request(_method: str, _params: object, *, response_model: type, **_kwargs: object):
        return response_model.model_validate({"generation": 4, "tasks": [row]})

    monkeypatch.setattr(client, "request", request)
    with pytest.raises(SdkProtocolError, match="malformed Task response"):
        client.list_tasks()
