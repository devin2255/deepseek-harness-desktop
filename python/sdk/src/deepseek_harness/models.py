from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated, Literal, TypeAlias

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator, model_validator

JsonScalar: TypeAlias = str | int | float | bool | None
JsonValue: TypeAlias = JsonScalar | dict[str, "JsonValue"] | list["JsonValue"]
JsonObject: TypeAlias = dict[str, JsonValue]


@dataclass(slots=True)
class Notification:
    method: str
    payload: JsonObject


@dataclass(slots=True)
class IncomingRequest:
    id: str | int
    method: str
    payload: JsonObject


class ServerInfo(BaseModel):
    name: str | None = None
    version: str | None = None


class InitializeResponse(BaseModel):
    serverInfo: ServerInfo | None = None


class TaskWireModel(BaseModel):
    """Strict base for Task values crossing the SDK wire."""

    model_config = ConfigDict(extra="forbid", strict=True, populate_by_name=True)


class TaskEvidenceRef(TaskWireModel):
    session_id: str = Field(alias="sessionId")
    seq: int


class TaskCriterion(TaskWireModel):
    id: str
    text: str
    status: Literal["pending", "satisfied", "failed", "waived"]
    evidence: list[TaskEvidenceRef]


class DefineTaskCriterion(TaskWireModel):
    id: str | None = None
    text: str


class TaskDefinition(TaskWireModel):
    goal: str
    criteria: list[TaskCriterion]


class TaskRisk(TaskWireModel):
    id: str
    severity: Literal["low", "medium", "high", "critical"]
    summary: str
    resolution: str | None = None


class AttentionItem(TaskWireModel):
    id: str
    task_id: str = Field(alias="taskId")
    owner_session_id: str = Field(alias="ownerSessionId")
    kind: Literal[
        "approval", "question", "plan-review", "run-failure", "merge-conflict",
        "validation-failure", "review-request", "delivery-unconfirmed",
    ]
    severity: Literal["info", "warning", "error", "critical"]
    summary: str
    created_at: int = Field(alias="createdAt")
    source_id: str = Field(alias="sourceId")
    actionable: bool


class TaskWorktreeAssignment(TaskWireModel):
    kind: Literal["git-worktree"]
    task_id: str = Field(alias="taskId")
    workspace_id: str = Field(alias="workspaceId")
    source_path: str = Field(alias="sourcePath", min_length=1)
    path: str = Field(min_length=1)
    branch: str = Field(pattern=r"^dsh/task-[0-9a-f]{24}$")
    base_commit: str = Field(alias="baseCommit", pattern=r"^[0-9a-f]{40}$")
    source_head: str = Field(alias="sourceHead", pattern=r"^[0-9a-f]{40}$")
    source_dirty: bool = Field(alias="sourceDirty")
    source_status_digest: str = Field(alias="sourceStatusDigest", pattern=r"^[0-9a-f]{64}$")
    created_at: int = Field(alias="createdAt", ge=0)

    @model_validator(mode="after")
    def validate_base_commit(self) -> "TaskWorktreeAssignment":
        if self.base_commit != self.source_head:
            raise ValueError("baseCommit must equal sourceHead")
        return self


class TaskReviewFile(TaskWireModel):
    path: str
    previous_path: str | None = Field(default=None, alias="previousPath")
    status: Literal[
        "added", "modified", "deleted", "renamed", "copied", "type-changed", "untracked", "conflicted",
    ]
    binary: bool
    additions: int | None = Field(ge=0)
    deletions: int | None = Field(ge=0)

    @field_validator("path", "previous_path")
    @classmethod
    def validate_review_path(cls, value: str | None) -> str | None:
        if value is None:
            return None
        segments = value.split("/")
        if not value or value.startswith("/") or "\\" in value or "\x00" in value or any(
            segment in {"", ".", ".."} for segment in segments
        ):
            raise ValueError("review path must be normalized and repository-relative")
        return value


class TaskReviewSummary(TaskWireModel):
    task_id: str = Field(alias="taskId")
    workspace_id: str = Field(alias="workspaceId")
    revision: str = Field(pattern=r"^[0-9a-f]{64}$")
    base_commit: str = Field(alias="baseCommit", pattern=r"^[0-9a-f]{40}$")
    head_commit: str = Field(alias="headCommit", pattern=r"^[0-9a-f]{40}$")
    source_head: str = Field(alias="sourceHead", pattern=r"^[0-9a-f]{40}$")
    source_dirty: bool = Field(alias="sourceDirty")
    branch: str = Field(min_length=1)
    dirty: bool
    truncated: bool
    files: list[TaskReviewFile]
    additions: int = Field(ge=0)
    deletions: int = Field(ge=0)


class TaskFileDiff(TaskWireModel):
    task_id: str = Field(alias="taskId")
    workspace_id: str = Field(alias="workspaceId")
    revision: str = Field(pattern=r"^[0-9a-f]{64}$")
    path: str
    previous_path: str | None = Field(default=None, alias="previousPath")
    binary: bool
    truncated: bool
    patch: str

    _validate_path = field_validator("path", "previous_path")(TaskReviewFile.validate_review_path.__func__)


class TaskReceipt(TaskWireModel):
    operation_id: str = Field(
        alias="operationId",
        pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    )
    task_id: str = Field(alias="taskId")
    workspace_id: str = Field(alias="workspaceId")
    review_revision: str = Field(alias="reviewRevision", pattern=r"^[0-9a-f]{64}$")


class TaskCommitReceipt(TaskReceipt):
    kind: Literal["commit"]
    committed_revision: str = Field(alias="committedRevision", pattern=r"^[0-9a-f]{64}$")
    branch: str = Field(min_length=1)
    commit: str = Field(pattern=r"^[0-9a-f]{40}$")
    committed_at: int = Field(alias="committedAt", ge=0)


class TaskApplyReceipt(TaskReceipt):
    kind: Literal["apply"]
    commit: str = Field(pattern=r"^[0-9a-f]{40}$")
    source_head_before: str = Field(alias="sourceHeadBefore", pattern=r"^[0-9a-f]{40}$")
    source_head_after: str = Field(alias="sourceHeadAfter", pattern=r"^[0-9a-f]{40}$")
    applied_at: int = Field(alias="appliedAt", ge=0)


class TaskDiscardReceipt(TaskReceipt):
    kind: Literal["discard"]
    branch: str = Field(min_length=1)
    branch_preserved: bool = Field(alias="branchPreserved")
    worktree_removed: bool = Field(alias="worktreeRemoved")
    uncommitted_changes_discarded: bool = Field(alias="uncommittedChangesDiscarded")
    recoverable_commit: str | None = Field(default=None, alias="recoverableCommit", pattern=r"^[0-9a-f]{40}$")
    discarded_at: int = Field(alias="discardedAt", ge=0)


def _integration_text(value: str) -> str:
    if not value or value != value.strip():
        raise ValueError("integration text must be nonblank without surrounding whitespace")
    return value


_IntegrationText: TypeAlias = Annotated[str, AfterValidator(_integration_text)]


class TaskIntegrationContributor(TaskWireModel):
    session_id: _IntegrationText = Field(alias="sessionId")
    branch: _IntegrationText
    commit: str = Field(pattern=r"^[0-9a-f]{40}$")
    review_revision: str = Field(alias="reviewRevision", pattern=r"^[0-9a-f]{64}$")


class TaskIntegrationResult(TaskReceipt):
    head_before: str = Field(alias="headBefore", pattern=r"^[0-9a-f]{40}$")
    contributors: list[TaskIntegrationContributor] = Field(min_length=1)


class TaskIntegrationReceipt(TaskIntegrationResult):
    kind: Literal["integrated"]
    head_after: str = Field(alias="headAfter", pattern=r"^[0-9a-f]{40}$")
    integrated_at: int = Field(alias="integratedAt", ge=0)


class TaskIntegrationConflict(TaskIntegrationResult):
    kind: Literal["conflict"]
    conflicting_session_id: _IntegrationText = Field(alias="conflictingSessionId")
    paths: list[str] = Field(min_length=1)
    detected_at: int = Field(alias="detectedAt", ge=0)

    @field_validator("paths")
    @classmethod
    def validate_paths(cls, paths: list[str]) -> list[str]:
        for path in paths:
            TaskReviewFile.validate_review_path(path)
            if len(path) >= 2 and path[0].isascii() and path[0].isalpha() and path[1] == ":":
                raise ValueError("integration paths must be repository-relative")
        return paths

    @model_validator(mode="after")
    def validate_conflicting_session(self) -> "TaskIntegrationConflict":
        if self.conflicting_session_id not in [item.session_id for item in self.contributors]:
            raise ValueError("conflictingSessionId must identify a contributor")
        return self


class TaskIntegrationPending(TaskWireModel):
    kind: Literal["running", "unconfirmed"]


class TaskIntegrationFailed(TaskWireModel):
    kind: Literal["failed"]
    message: _IntegrationText


class TaskIntegrationIntegrated(TaskWireModel):
    kind: Literal["integrated"]
    result: TaskIntegrationReceipt


class TaskIntegrationConflicted(TaskWireModel):
    kind: Literal["conflict"]
    result: TaskIntegrationConflict


TaskIntegrationOutcome: TypeAlias = Annotated[
    TaskIntegrationPending | TaskIntegrationFailed | TaskIntegrationIntegrated | TaskIntegrationConflicted,
    Field(discriminator="kind"),
]


class TaskIntegrationNode(TaskWireModel):
    """One logged integration attempt; an unconfirmed outcome never proves Git publication."""

    id: _IntegrationText
    call_seq: int = Field(alias="callSeq", ge=0)
    started_at: int = Field(alias="startedAt", ge=0)
    writer_session_ids: list[_IntegrationText] = Field(alias="writerSessionIds")
    outcome: TaskIntegrationOutcome
    finished_at: int | None = Field(default=None, alias="finishedAt", ge=0)
    resolved_by: _IntegrationText | None = Field(default=None, alias="resolvedBy")

    @model_validator(mode="after")
    def validate_selected_writers(self) -> "TaskIntegrationNode":
        if len(set(self.writer_session_ids)) != len(self.writer_session_ids):
            raise ValueError("writerSessionIds must be unique")
        if self.resolved_by is not None and self.outcome.kind != "conflict":
            raise ValueError("only a conflict can identify a later resolution")
        return self


class TaskSnapshot(TaskWireModel):
    task_id: str = Field(alias="taskId")
    workspace_id: str | None = Field(default=None, alias="workspaceId")
    execution_workspace: TaskWorktreeAssignment | None = Field(default=None, alias="executionWorkspace")
    definition: TaskDefinition | None = None
    descendant_session_ids: list[str] = Field(alias="descendantSessionIds")
    status: Literal["needs-attention", "failed", "running", "reviewing", "ready", "settled"]
    freshness: Literal["live", "disconnected", "unavailable"]
    attention: list[AttentionItem]
    risks: list[TaskRisk]
    review_decision: Literal["changes-requested", "ready"] | None = Field(default=None, alias="reviewDecision")
    commit_receipt: TaskCommitReceipt | None = Field(default=None, alias="commitReceipt")
    apply_receipt: TaskApplyReceipt | None = Field(default=None, alias="applyReceipt")
    discard_receipt: TaskDiscardReceipt | None = Field(default=None, alias="discardReceipt")
    retryable_delivery_checkpoint: str | None = Field(
        default=None, alias="retryableDeliveryCheckpoint",
        pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    )
    integrations: list[TaskIntegrationNode] | None = Field(default=None, min_length=1)
    updated_at: int = Field(alias="updatedAt")
    as_of_seq: int = Field(alias="asOfSeq")

    @model_validator(mode="after")
    def validate_execution_workspace(self) -> "TaskSnapshot":
        assignment = self.execution_workspace
        if assignment is not None and (
            assignment.task_id != self.task_id or assignment.workspace_id != self.workspace_id
        ):
            raise ValueError("executionWorkspace must match the Task and Workspace identities")
        receipts = [self.commit_receipt, self.apply_receipt, self.discard_receipt]
        if self.retryable_delivery_checkpoint is not None and not any(
            item.kind == "delivery-unconfirmed" and item.owner_session_id == self.task_id
            and item.source_id == self.retryable_delivery_checkpoint for item in self.attention
        ):
            raise ValueError("retryable checkpoint must match an unconfirmed root delivery")
        if any(receipt is not None and (
            receipt.task_id != self.task_id or receipt.workspace_id != self.workspace_id
        ) for receipt in receipts):
            raise ValueError("delivery receipts must match the Task and Workspace identities")
        if self.apply_receipt is not None and (
            self.commit_receipt is None
            or self.apply_receipt.commit != self.commit_receipt.commit
            or self.apply_receipt.review_revision != self.commit_receipt.committed_revision
        ):
            raise ValueError("applyReceipt must consume the recorded Task commit")
        if self.discard_receipt is not None and assignment is not None and (
            self.discard_receipt.branch != assignment.branch
        ):
            raise ValueError("discardReceipt must identify the assigned Task branch")
        previous_seq = -1
        nodes = self.integrations or []
        for index, node in enumerate(nodes):
            if node.id != f"{self.task_id}:integration:{node.call_seq}" or not (
                previous_seq < node.call_seq < self.as_of_seq
            ):
                raise ValueError("integration ids and call sequences must match the owning Task log")
            previous_seq = node.call_seq
            if isinstance(node.outcome, (TaskIntegrationIntegrated, TaskIntegrationConflicted)):
                result = node.outcome.result
                selected = [item.session_id for item in result.contributors]
                if result.task_id != self.task_id or result.workspace_id != self.workspace_id or (
                    selected != node.writer_session_ids
                    or any(writer not in self.descendant_session_ids for writer in selected)
                ):
                    raise ValueError("integration results must match the Task and selected descendants")
            if node.outcome.kind == "conflict":
                remaining = set(node.writer_session_ids)
                resolved_by = None
                for later in nodes[index + 1:]:
                    if later.outcome.kind == "integrated":
                        remaining.difference_update(later.writer_session_ids)
                        if not remaining:
                            resolved_by = later.id
                            break
                if node.resolved_by != resolved_by:
                    raise ValueError("resolvedBy must identify complete later contributor coverage")
        return self


class TaskListSnapshot(TaskWireModel):
    generation: int
    tasks: list[TaskSnapshot]
