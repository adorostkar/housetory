import uuid

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from ...db import get_db
from ...schemas.properties import (
    PropertyCreate,
    PropertyList,
    PropertyOut,
    PropertyUpdate,
)
from ...services import properties as service
from ..deps import AuthContext, require_auth

router = APIRouter(prefix="/properties", tags=["properties"])


@router.get("", response_model=PropertyList)
def list_properties(
    include_archived: bool = False,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> PropertyList:
    return service.list_properties(db, auth.household.id, include_archived=include_archived)


@router.post("", response_model=PropertyOut, status_code=201)
def create_property(
    payload: PropertyCreate,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> PropertyOut:
    return service.create_property(db, auth.household.id, payload)


@router.get("/{property_id}", response_model=PropertyOut)
def read_property(
    property_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> PropertyOut:
    return service.read_property(db, auth.household.id, property_id)


@router.patch("/{property_id}", response_model=PropertyOut)
def update_property(
    property_id: uuid.UUID,
    payload: PropertyUpdate,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> PropertyOut:
    record = service.get_property(db, auth.household.id, property_id)
    return service.update_property(db, auth.household.id, record, payload)


@router.delete("/{property_id}", status_code=204)
def delete_property(
    property_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> Response:
    record = service.get_property(db, auth.household.id, property_id)
    service.delete_property(db, auth.household.id, record)
    return Response(status_code=204)
