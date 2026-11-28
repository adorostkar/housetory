import hashlib
import json
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from ...db import get_db
from ...schemas.auth import UserOut
from ...schemas.offline import OfflineSnapshot
from ...services import lending
from ...services import offline as offline_service
from ...services.households import household_out
from ..deps import AuthContext, require_auth
from . import containers, locations, overview, properties, rooms, taxonomy

router = APIRouter(prefix="/offline", tags=["offline"])

# Larger than any household; the list routes are called directly, not over HTTP.
EVERYTHING = 1_000_000


def require_offline_copy(auth: AuthContext = Depends(require_auth)) -> AuthContext:
    offline_service.require_offline_copy(auth.household, auth.role)
    return auth


@router.get("/snapshot", response_model=OfflineSnapshot)
def snapshot(
    request: Request,
    auth: AuthContext = Depends(require_offline_copy),
    db: Session = Depends(get_db),
) -> Response:
    """One household, read in one request, in the shapes the list and detail routes return.

    The ETag covers everything but the time of reading, so a device that already
    has this content gets a short 304 answer.
    """
    household_id = auth.household.id
    content = OfflineSnapshot(
        generated_at=datetime.now(UTC),
        user=UserOut.model_validate(auth.user),
        household=household_out(auth.household),
        role=auth.role,
        properties=properties.list_properties(include_archived=True, auth=auth, db=db),
        rooms=rooms.list_rooms(property_id=None, auth=auth, db=db),
        locations=locations.list_locations(
            room_id=None, q=None, is_container=None, auth=auth, db=db
        ),
        categories=taxonomy.list_categories(auth=auth, db=db),
        tags=taxonomy.list_tags(auth=auth, db=db),
        containers=containers.list_containers(
            q=None,
            property_id=None,
            room_id=None,
            container_type=None,
            empty=None,
            include_fixed=True,
            include_owned=True,
            limit=EVERYTHING,
            offset=0,
            auth=auth,
            db=db,
        ),
        items=offline_service.snapshot_items(db, auth.household),
        loans=lending.list_loans(db, household_id, status="open", limit=EVERYTHING),
        overview=overview.overview(include_financial=False, auth=auth, db=db),
    ).model_dump(mode="json")
    generated_at = content.pop("generated_at")
    digest = hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()
    etag = f'"{digest}"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag})
    return JSONResponse({**content, "generated_at": generated_at}, headers={"ETag": etag})


@router.get("/photos/{photo_id}")
def small_photo(
    photo_id: uuid.UUID,
    auth: AuthContext = Depends(require_offline_copy),
    db: Session = Depends(get_db),
) -> Response:
    """A small copy of an item photo, for the offline copy on a device."""
    return Response(
        content=offline_service.small_photo(db, auth.household.id, photo_id),
        media_type="image/webp",
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Cross-Origin-Resource-Policy": "same-origin",
        },
    )
