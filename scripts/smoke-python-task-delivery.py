#!/usr/bin/env python3
"""Snapshot real Python SDK Task delivery over the built Node runtime and Git."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from deepseek_harness import DeepSeekHarness, HarnessClient, HarnessConfig
from deepseek_harness.errors import JsonRpcError
from deepseek_harness.models import TaskSnapshot


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", default=shutil.which("node"))
    parser.add_argument("--update-snapshots", action="store_true")
    args = parser.parse_args()
    if args.node is None:
        parser.error("Node.js is required for the built-runtime Task fixture")
    repository = Path(__file__).resolve().parent.parent
    fixture = repository / "examples/jsonrpc-agent/tests/fixtures/task-delivery"
    expected = repository / "scripts/snapshots/python-sdk-single-exe/task-delivery/result.json"
    with tempfile.TemporaryDirectory(prefix="dsh-python-delivery-") as temporary:
        root = Path(temporary).resolve()
        config = HarnessConfig(
            launch_args_override=(args.node, str(fixture / "driver.ts"), str(fixture / "cordis.yml")),
            cwd=str(root),
            env={"DSH_HOME": str(root / ".dsh"), "DSH_AGENTS_HOME": str(root / ".agents")},
            request_timeout_seconds=30,
            shutdown_timeout_seconds=10,
        )

        def git(*arguments: str) -> str:
            return subprocess.check_output(
                ["git", *arguments], cwd=root / "source", text=True, encoding="utf-8",
            ).strip()

        def task(client: HarnessClient, task_id: str) -> TaskSnapshot:
            return next(row for row in client.list_tasks().tasks if row.task_id == task_id)

        def reject_commit(client: HarnessClient, row: TaskSnapshot, revision: str) -> str:
            try:
                client.commit_task(row.task_id, expected_revision=revision,
                                   expected_seq=row.as_of_seq, message="SDK lost result")
            except JsonRpcError as error:
                return error.message
            raise AssertionError("Unconfirmed delivery was accepted")

        def reject_checkpoint(client: HarnessClient, operation_id: str) -> None:
            try:
                client.retry_task_delivery_checkpoint("unconfirmed", operation_id)
            except JsonRpcError as error:
                assert "No matching live delivery receipt" in error.message
                return
            raise AssertionError("Missing receipt checkpoint was accepted")

        with DeepSeekHarness(
            launch_args_override=config.launch_args_override, cwd=config.cwd, env=config.env,
            request_timeout_seconds=30, shutdown_timeout_seconds=10, model="fixture",
        ) as harness:
            client = harness.client
            with client.subscribe_notifications() as subscription:
                initial = task(client, "delivered")
                summary = client.get_task_review_summary("delivered")
                committed = client.commit_task("delivered", expected_revision=summary.revision,
                                               expected_seq=initial.as_of_seq, message="SDK delivery")
                receipt = committed.commit_receipt
                assert receipt is not None
                applied = client.apply_task("delivered", expected_revision=receipt.committed_revision,
                                            expected_source_head=summary.source_head, commit=receipt.commit,
                                            expected_seq=committed.as_of_seq)
                discarded = client.discard_task("delivered", expected_revision=receipt.committed_revision,
                                                confirmed_uncommitted_loss=False, expected_seq=applied.as_of_seq)
                checkpoint_before = task(client, "checkpoint")
                checkpoint_summary = client.get_task_review_summary("checkpoint")
                try:
                    client.commit_task("checkpoint", expected_revision=checkpoint_summary.revision,
                                       expected_seq=checkpoint_before.as_of_seq, message="SDK save receipt")
                except JsonRpcError as error:
                    assert "Delivery result is unconfirmed" in error.message
                else:
                    raise AssertionError("Receipt checkpoint failure was accepted")
                checkpoint = task(client, "checkpoint")
                checkpoint_id = checkpoint.retryable_delivery_checkpoint
                assert checkpoint_id is not None and checkpoint.execution_workspace is not None
                checkpoint_head = git("rev-parse", checkpoint.execution_workspace.branch)
                saved = harness.retry_task_delivery_checkpoint("checkpoint", checkpoint_id)
                assert saved.retryable_delivery_checkpoint is None
                assert not any(item.kind == "delivery-unconfirmed" for item in saved.attention)
                assert saved.commit_receipt is not None and saved.commit_receipt.operation_id == checkpoint_id
                assert saved.as_of_seq == checkpoint.as_of_seq
                assert git("rev-parse", checkpoint.execution_workspace.branch) == checkpoint_head
                before = client.get_task_review_summary("unconfirmed")
                assert "Delivery result is unconfirmed" in reject_commit(client, task(client, "unconfirmed"), before.revision)
                pending = task(client, "unconfirmed")
                notifications = []
                subscription.drain(notifications.append)
            events = [notification.payload["event"] for notification in notifications
                      if notification.method == "session.event"]
            intents = [event["data"]["intent"] for event in events if event["type"] == "task/delivery-started"]
            completions = [event["data"]["receipt"] for event in events if event["type"] in {
                "task/review-committed", "task/review-applied", "task/review-discarded",
            }]
            operations = [intent["kind"] for intent in intents]
            assert operations == ["commit", "apply", "discard", "commit", "commit"], operations
            assert len(completions) == 4, completions
            for completed in completions:
                assert any(all(intent[key] == completed[key] for key in ("operationId", "kind", "reviewRevision"))
                           for intent in intents), completed
            operation_id = next(item.source_id for item in pending.attention if item.kind == "delivery-unconfirmed")
            assert operation_id == intents[4]["operationId"]
            assert pending.retryable_delivery_checkpoint is None
            assert pending.commit_receipt is None
            reject_checkpoint(client, operation_id)
            assert pending.execution_workspace is not None
            branch = pending.execution_workspace.branch
            lost_commit = git("rev-parse", branch)
            assert git("show", "-s", "--format=%s", lost_commit) == "SDK lost result"
            assert (root / "source/tracked.txt").read_text(encoding="utf-8") == "delivered\n"
            assert git("rev-parse", "HEAD") == summary.source_head
            assert initial.execution_workspace is not None
            assert git("rev-parse", initial.execution_workspace.branch) == receipt.commit
            assert not Path(initial.execution_workspace.path).exists()
        with HarnessClient(config) as client:
            client.initialize(cwd=str(root), provider="deepseek-official", model="fixture")
            cold = task(client, "unconfirmed")
            cold_saved = task(client, "checkpoint")
            assert cold_saved.commit_receipt is not None and cold_saved.commit_receipt.operation_id == checkpoint_id
            assert cold_saved.retryable_delivery_checkpoint is None
            assert not any(item.kind == "delivery-unconfirmed" for item in cold_saved.attention)
            assert cold_saved.as_of_seq == saved.as_of_seq
            assert git("rev-parse", checkpoint.execution_workspace.branch) == checkpoint_head
            assert next(item.source_id for item in cold.attention if item.kind == "delivery-unconfirmed") == operation_id
            reject_checkpoint(client, operation_id)
            reject_commit(client, cold, before.revision)
            assert git("rev-parse", branch) == lost_commit
            result = {
                "operations": operations,
                "correlatedReceipts": [completed["kind"] for completed in completions],
                "status": discarded.status,
                "sourceHeadPreserved": True,
                "sourceContentApplied": True,
                "worktreeRemoved": True,
                "branchRetained": True,
                "checkpointRetry": {
                    "advertised": True, "operationIdMatched": True, "attentionCleared": True,
                    "noEventAppended": True, "gitCommitPreserved": True,
                    "coldReceiptRetained": True,
                },
                "missingReceiptRetryRejected": {"live": True, "cold": True},
                "unconfirmed": {
                    "status": cold.status,
                    "attention": [item.kind for item in cold.attention],
                    "operationIdRetained": True,
                    "receiptAbsent": cold.commit_receipt is None,
                    "retryRejected": True,
                    "gitCommitPreserved": True,
                },
            }
        output = json.dumps(result, indent=2, ensure_ascii=False) + "\n"
        if args.update_snapshots:
            expected.parent.mkdir(parents=True, exist_ok=True)
            expected.write_text(output, encoding="utf-8")
        assert output == expected.read_text(encoding="utf-8"), output
    print("smoke-python-task-delivery: passed")


if __name__ == "__main__":
    main()
