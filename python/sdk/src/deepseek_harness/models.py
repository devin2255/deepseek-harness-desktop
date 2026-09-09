from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, TypeAlias

from pydantic import BaseModel, ConfigDict, Field, model_validator

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
    review_decision: Literal[
        "changes-requested", "ready", "committed", "applied", "archived", "discarded",
    ] | None = Field(default=None, alias="reviewDecision")
    updated_at: int = Field(alias="updatedAt")
    as_of_seq: int = Field(alias="asOfSeq")

    @model_validator(mode="after")
    def validate_execution_workspace(self) -> "TaskSnapshot":
        assignment = self.execution_workspace
        if assignment is not None and (
            assignment.task_id != self.task_id or assignment.workspace_id != self.workspace_id
        ):
            raise ValueError("executionWorkspace must match the Task and Workspace identities")
        return self


class TaskListSnapshot(TaskWireModel):
    generation: int
    tasks: list[TaskSnapshot]
