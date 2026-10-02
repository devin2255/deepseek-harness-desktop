from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, TypeAlias

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

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
        "validation-failure", "review-request",
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
        if self.discard_receipt is not None and self.commit_receipt is not None and (
            self.discard_receipt.review_revision != self.commit_receipt.committed_revision
        ):
            raise ValueError("discardReceipt must identify the committed review revision")
        return self


class TaskListSnapshot(TaskWireModel):
    generation: int
    tasks: list[TaskSnapshot]
