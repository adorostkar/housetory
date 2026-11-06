import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from ...db import get_db
from ...schemas.ai_settings import (
    AiCredentialRotationOut,
    AiProviderCreate,
    AiProviderModels,
    AiProviderOut,
    AiProviderTest,
    AiProviderUpdate,
    AiSettingsOut,
    AiTaskSettingOut,
    AiTaskSettingUpdate,
    AiTaskTestOut,
    AiTaskTestRequest,
)
from ...services import ai_settings as settings_service
from ...services.ai_task_test import run_task_test
from ..deps import AuthContext, require_owner
from ..errors import ApiError

router = APIRouter(prefix="/ai", tags=["ai-settings"])


@router.get("/settings", response_model=AiSettingsOut)
def read_ai_settings(
    auth: AuthContext = Depends(require_owner),
    db: Session = Depends(get_db),
) -> AiSettingsOut:
    return settings_service.ai_settings(db, auth.household.id)


@router.post("/providers", response_model=AiProviderOut, status_code=201)
def create_provider(
    payload: AiProviderCreate,
    auth: AuthContext = Depends(require_owner),
    db: Session = Depends(get_db),
) -> AiProviderOut:
    try:
        provider = settings_service.create_provider(db, auth.household.id, payload)
    except Exception:
        db.rollback()
        raise
    return settings_service.serialize_provider(provider)


@router.patch("/providers/{provider_id}", response_model=AiProviderOut)
def update_provider(
    provider_id: uuid.UUID,
    payload: AiProviderUpdate,
    auth: AuthContext = Depends(require_owner),
    db: Session = Depends(get_db),
) -> AiProviderOut:
    try:
        provider = settings_service.update_provider(db, auth.household.id, provider_id, payload)
    except Exception:
        db.rollback()
        raise
    return settings_service.serialize_provider(provider)


@router.delete("/providers/{provider_id}", status_code=204)
def delete_provider(
    provider_id: uuid.UUID,
    auth: AuthContext = Depends(require_owner),
    db: Session = Depends(get_db),
) -> None:
    settings_service.delete_provider(db, auth.household.id, provider_id)


@router.get("/providers/{provider_id}/models", response_model=AiProviderModels)
def provider_models(
    provider_id: uuid.UUID,
    refresh: bool = False,
    auth: AuthContext = Depends(require_owner),
    db: Session = Depends(get_db),
) -> AiProviderModels:
    return settings_service.provider_models(db, auth.household.id, provider_id, refresh=refresh)


@router.post("/providers/{provider_id}/test", response_model=AiProviderTest)
def test_provider(
    provider_id: uuid.UUID,
    auth: AuthContext = Depends(require_owner),
    db: Session = Depends(get_db),
    model: Annotated[str | None, Query(max_length=160)] = None,
) -> AiProviderTest:
    return settings_service.test_provider(db, auth.household.id, provider_id, model=model)


@router.put("/tasks/{task}", response_model=AiTaskSettingOut)
def update_task(
    task: str,
    payload: AiTaskSettingUpdate,
    auth: AuthContext = Depends(require_owner),
    db: Session = Depends(get_db),
) -> AiTaskSettingOut:
    try:
        return settings_service.update_task(db, auth.household.id, task, payload)
    except Exception:
        db.rollback()
        raise


@router.post("/tasks/{task}/test", response_model=AiTaskTestOut)
def test_task(
    task: str,
    payload: AiTaskTestRequest,
    auth: AuthContext = Depends(require_owner),
    db: Session = Depends(get_db),
) -> AiTaskTestOut:
    try:
        return run_task_test(
            db,
            auth.household.id,
            task,
            confirm=payload.confirm,
        )
    except Exception:
        db.rollback()
        raise


@router.post("/credentials/rotate", response_model=AiCredentialRotationOut)
def rotate_credentials(
    auth: AuthContext = Depends(require_owner),
    db: Session = Depends(get_db),
) -> AiCredentialRotationOut:
    try:
        rotated, failed = settings_service.rotate_credentials(db, auth.household.id)
    except Exception:
        db.rollback()
        raise
    if failed:
        raise ApiError(
            409,
            "credential_rotation_incomplete",
            f"Rotated {rotated} credential(s); {failed} could not be decrypted. "
            "Restore the previous key, verify the credentials, then retry.",
        )
    return AiCredentialRotationOut(rotated=rotated, failed=failed)
