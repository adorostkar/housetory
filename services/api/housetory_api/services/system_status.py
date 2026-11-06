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
    SystemStatusOut,
    TaskStatusOut,
)
from . import ai, item_image_search, manual_web
from . import ai_settings as settings_service

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
    image_policy = item_image_search.permitted_source_policy_configured(image)
    manual_configured = manual.kind != "none"
    image_configured = image.configured and image_policy
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
            status=(
                "configured"
                if image_configured
                else "partial"
                if image.configured
                else "not_configured"
            ),
            detail=(
                f"Configured via {_source_label(image.source)} with "
                f"{len(image.permitted_domains)} permitted source domain(s) (not probed)."
                if image_configured
                else "Search provider is configured, but no permitted source domains "
                "are set in Settings → Online search."
                if image.configured
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


def system_status(db: Session, household_id: uuid.UUID) -> SystemStatusOut:
    return SystemStatusOut(
        release=_release(),
        readiness=_readiness(db),
        jobs=_jobs(db, household_id),
        tasks=_tasks(db, household_id),
        external_services=_external_services(db, household_id),
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
