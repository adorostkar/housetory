"""Owner-facing system status built from real local evidence, not probes."""

from __future__ import annotations

import tempfile
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, or_, select, text
from sqlalchemy.orm import Session

from .. import __version__
from ..api.errors import ApiError
from ..config import get_settings
from ..domain import AiTask, JobStatus
from ..models import Job, WorkerHeartbeat
from ..schemas.system import (
    ExternalServiceStatus,
    FailedJobOut,
    JobRetryOut,
    JobStatusOut,
    ReadinessComponent,
    ReleaseStatus,
    ScheduledReviewStatus,
    SystemStatusIssue,
    SystemStatusOut,
    SystemStatusSummaryOut,
    TaskStatusOut,
)
from . import ai, item_image_search, manual_web
from . import ai_settings as settings_service
from .inventory_review_schedule import schedule_summary

TASK_ORDER = (
    AiTask.ASSISTANT.value,
    AiTask.DOCUMENTS.value,
    AiTask.IMPORTS.value,
    AiTask.ITEM_IMAGES.value,
    AiTask.LABELS.value,
    AiTask.SEARCH.value,
    AiTask.TRANSCRIPTION.value,
    AiTask.VISION.value,
)


def _release() -> ReleaseStatus:
    settings = get_settings()
    return ReleaseStatus(
        version=__version__,
        commit=settings.release_commit or "unknown",
        build_time=settings.release_build_time or "unknown",
        channel=settings.release_channel or "local",
        environment=settings.environment,
        identity=settings.server_identity or settings.app_base_url,
    )


def _readiness(db: Session) -> list[ReadinessComponent]:
    components: list[ReadinessComponent] = []
    try:
        db.execute(text("SELECT 1"))
        components.append(ReadinessComponent(name="Database", status="ok"))
    except Exception:  # noqa: BLE001 - status must stay honest if the DB fails
        components.append(
            ReadinessComponent(
                name="Database",
                status="degraded",
                detail="The database readiness query failed.",
            )
        )

    try:
        root = get_settings().resolved_uploads_dir
        root.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=root, prefix=".status-", delete=True):
            pass
        components.append(ReadinessComponent(name="Storage", status="ok"))
    except Exception:  # noqa: BLE001
        components.append(
            ReadinessComponent(
                name="Storage",
                status="degraded",
                detail="The uploads volume is not writable.",
            )
        )

    try:
        heartbeat = db.scalar(
            select(WorkerHeartbeat).order_by(WorkerHeartbeat.updated_at.desc()).limit(1)
        )
        if heartbeat is None:
            components.append(
                ReadinessComponent(
                    name="Worker",
                    status="unknown",
                    detail="No worker heartbeat has been recorded.",
                )
            )
        else:
            age = datetime.now(UTC) - heartbeat.updated_at
            stale = age > timedelta(seconds=60)
            components.append(
                ReadinessComponent(
                    name="Worker",
                    status="degraded" if stale else "ok",
                    detail=(
                        f"Last heartbeat {max(0, int(age.total_seconds()))}s ago "
                        f"(v{heartbeat.version})."
                    ),
                )
            )
    except Exception:  # noqa: BLE001
        components.append(
            ReadinessComponent(
                name="Worker",
                status="unknown",
                detail="Worker heartbeat could not be read.",
            )
        )
    return components


def _job_scope(household_id: uuid.UUID):
    return or_(
        Job.payload["household_id"].astext == str(household_id),
        Job.task.like("maintenance.%"),
    )


def _jobs(db: Session, household_id: uuid.UUID) -> JobStatusOut:
    scope = _job_scope(household_id)
    counts = {
        str(status): int(count or 0)
        for status, count in db.execute(
            select(Job.status, func.count(Job.id)).where(scope).group_by(Job.status)
        ).all()
    }
    recent_failed = db.scalars(
        select(Job)
        .where(Job.status == JobStatus.FAILED.value, scope)
        .order_by(Job.finished_at.desc().nullslast(), Job.created_at.desc())
        .limit(10)
    ).all()
    return JobStatusOut(
        counts=counts,
        recent_failed=[
            FailedJobOut(
                id=job.id,
                task=job.task,
                attempts=job.attempts,
                max_attempts=job.max_attempts,
                error=(job.last_error or "")[:400] or None,
                created_at=job.created_at,
                finished_at=job.finished_at,
            )
            for job in recent_failed
        ],
    )


def _tasks(db: Session, household_id: uuid.UUID) -> list[TaskStatusOut]:
    tasks: list[TaskStatusOut] = []
    for task in TASK_ORDER:
        serialized = settings_service.serialize_task(db, household_id, task)
        status = ai.status_for(db, household_id, task, probe=False)
        last_test_error = serialized.last_test_error
        error = None if status.configured else status.error
        if error is None and serialized.last_test_status == "failed":
            error = last_test_error
        tasks.append(
            TaskStatusOut(
                task=task,
                label=settings_service.TASK_LABELS.get(task, task),
                provider_label=serialized.provider_label,
                model=serialized.model,
                model_label=serialized.model_label,
                model_listed=serialized.model_listed,
                enabled=serialized.enabled,
                configured=status.configured,
                compatibility=serialized.compatibility,
                capabilities=serialized.capabilities,
                live_tested=serialized.last_test_status == "passed",
                last_test_status=serialized.last_test_status,
                last_test_at=serialized.last_test_at,
                last_test_error=last_test_error,
                error=error,
            )
        )
    return tasks


def _source_label(source: str | None) -> str:
    if source == "household":
        return "Household Settings"
    if source == "environment":
        return "Installation environment fallback"
    return "Not configured"


def _external_services(db: Session, household_id: uuid.UUID) -> list[ExternalServiceStatus]:
    settings = get_settings()
    manual = manual_web.resolve_search_provider(db, household_id)
    image = item_image_search.resolve_image_search_provider(db, household_id)
    manual_configured = manual.kind != "none"
    image_configured = image.configured
    return [
        ExternalServiceStatus(
            name="Online manual search",
            configured=manual_configured,
            status="configured" if manual_configured else "not_configured",
            detail=(
                f"Configured via {_source_label(manual.source)} (not probed)."
                if manual_configured
                else manual.reason or "Not configured."
            ),
            source=manual.source,
            settings_path="/settings#online-search",
        ),
        ExternalServiceStatus(
            name="Reference-image search",
            configured=image_configured,
            status="configured" if image_configured else "not_configured",
            detail=(
                (
                    f"Configured via {_source_label(image.source)} for public-web "
                    "reference-image lookup"
                    + (
                        f" with an optional restriction to {len(image.permitted_domains)} domain(s)"
                        if image.permitted_domains
                        else ""
                    )
                    + " (not probed)."
                )
                if image_configured
                else image.reason or "Not configured."
            ),
            source=image.source,
            settings_path="/settings#online-search",
        ),
        ExternalServiceStatus(
            name="Email delivery",
            configured=settings.email_configured,
            status="configured" if settings.email_configured else "not_configured",
            detail=(
                "SMTP is configured; delivery is not probed by this screen."
                if settings.email_configured
                else "SMTP is not configured; LAN login and password reset status remain local."
            ),
            source="environment" if settings.email_configured else "none",
        ),
    ]


def _failed_job_count(db: Session, household_id: uuid.UUID) -> int:
    return int(
        db.scalar(
            select(func.count(Job.id)).where(
                _job_scope(household_id),
                Job.status == JobStatus.FAILED.value,
            )
        )
        or 0
    )


def _scheduled_review(db: Session, household_id: uuid.UUID) -> ScheduledReviewStatus:
    summary = schedule_summary(db, household_id)
    return ScheduledReviewStatus(
        configured=summary.configured,
        enabled=summary.enabled,
        state=summary.state,
        state_detail=summary.state_detail,
        scope_label=summary.scope_label,
        frequency=summary.frequency,
        timezone=summary.timezone,
        include_ai=summary.include_ai,
        ai_consent_valid=summary.ai_consent_valid,
        assistant_configured=summary.assistant_configured,
        assistant_provider_label=summary.assistant_provider_label,
        assistant_model=summary.assistant_model,
        last_run_at=summary.last_run_at,
        last_run_status=summary.last_run_status,
        last_run_detail=summary.last_run_detail,
        next_due_at=summary.next_due_at,
        max_items=summary.max_items,
        max_runs_per_day=summary.max_runs_per_day,
        provider_request_cap=summary.provider_request_cap,
    )


def system_status_summary(db: Session, household_id: uuid.UUID) -> SystemStatusSummaryOut:
    readiness = _readiness(db)
    tasks = _tasks(db, household_id)
    external_services = _external_services(db, household_id)
    failed_jobs = _failed_job_count(db, household_id)
    scheduled_review = _scheduled_review(db, household_id)
    issues: list[SystemStatusIssue] = []
    for component in readiness:
        if component.status == "ok":
            continue
        issues.append(
            SystemStatusIssue(
                kind="core",
                label=f"{component.name} readiness",
                detail=component.detail or f"{component.name} is {component.status}.",
            )
        )
    if failed_jobs:
        issues.append(
            SystemStatusIssue(
                kind="core",
                label="Worker jobs",
                detail=(
                    f"{failed_jobs} failed job(s) recorded. Review the job details "
                    "and retry after fixing the cause."
                ),
                settings_path="/settings/system-status",
            )
        )
    for task in tasks:
        if not task.enabled:
            continue
        if not task.configured:
            issues.append(
                SystemStatusIssue(
                    kind="configured_feature",
                    label=task.label,
                    detail=(task.error or "This task is enabled but has no usable provider/model."),
                    settings_path="/settings/ai",
                )
            )
            continue
        failure = None
        if task.last_test_status == "failed":
            failure = task.last_test_error or "The last live task test failed."
        elif task.error:
            failure = task.error
        elif task.compatibility in {"incompatible", "adapter_unavailable"}:
            failure = "The selected model/provider combination is not usable for this task."
        if failure:
            issues.append(
                SystemStatusIssue(
                    kind="configured_feature",
                    label=task.label,
                    detail=failure,
                    settings_path="/settings/ai",
                )
            )
    for service in external_services:
        if service.status != "partial":
            continue
        issues.append(
            SystemStatusIssue(
                kind="configured_feature",
                label=service.name,
                detail=service.detail,
                settings_path=service.settings_path or "/settings#online-search",
            )
        )
    if scheduled_review.enabled and scheduled_review.state in {
        "consent_needed",
        "ai_not_configured",
        "attention",
    }:
        issues.append(
            SystemStatusIssue(
                kind="configured_feature",
                label="Scheduled inventory review",
                detail=scheduled_review.state_detail,
                settings_path="/review",
            )
        )
    optional: list[str] = []
    settings = get_settings()
    if not settings.email_configured:
        optional.append("Email delivery")
    for service in external_services:
        if service.status == "not_configured" and service.name not in optional:
            optional.append(service.name)
    if not any(task.configured for task in tasks):
        optional.append("AI tasks")
    if not scheduled_review.configured:
        optional.append("Scheduled inventory review")
    core_count = sum(1 for issue in issues if issue.kind == "core")
    configured_count = sum(1 for issue in issues if issue.kind == "configured_feature")
    return SystemStatusSummaryOut(
        status="attention" if issues else "healthy",
        attention_count=len(issues),
        core_issue_count=core_count,
        configured_feature_issue_count=configured_count,
        optional_not_configured=optional,
        issues=issues,
        generated_at=datetime.now(UTC),
    )


def system_status(db: Session, household_id: uuid.UUID) -> SystemStatusOut:
    return SystemStatusOut(
        release=_release(),
        readiness=_readiness(db),
        jobs=_jobs(db, household_id),
        tasks=_tasks(db, household_id),
        external_services=_external_services(db, household_id),
        scheduled_review=_scheduled_review(db, household_id),
        generated_at=datetime.now(UTC),
    )


def retry_job(
    db: Session,
    household_id: uuid.UUID,
    job_id: uuid.UUID,
) -> JobRetryOut:
    job = db.get(Job, job_id)
    scoped_household = (job.payload or {}).get("household_id") if job else None
    if job is None or (scoped_household is not None and str(scoped_household) != str(household_id)):
        raise ApiError(404, "job_not_found", "Job not found.")
    if scoped_household is None and not job.task.startswith("maintenance."):
        raise ApiError(404, "job_not_found", "Job not found.")
    if job.status != JobStatus.FAILED.value:
        raise ApiError(409, "job_not_failed", "Only failed jobs can be retried.")
    job.status = JobStatus.QUEUED.value
    job.attempts = 0
    job.run_at = datetime.now(UTC)
    job.finished_at = None
    job.locked_by = None
    job.locked_at = None
    job.last_error = None
    db.commit()
    return JobRetryOut(id=job.id, task=job.task, status=job.status)


__all__ = ["retry_job", "system_status"]
