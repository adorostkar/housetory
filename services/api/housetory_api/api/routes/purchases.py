import uuid
from datetime import date
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ...db import get_db
from ...models import Document, Item, Purchase
from ...schemas.purchases import (
    PurchaseCreate,
    PurchaseList,
    PurchaseMutationResponse,
    PurchaseOut,
    PurchaseUpdate,
)
from ...services.purchases import (
    create_purchase,
    delete_purchase,
    get_purchase,
    purchase_load_options,
    update_purchase,
)
from ...services.serializers import purchase_out
from ..deps import AuthContext, require_auth
from ..errors import ApiError

router = APIRouter(prefix="/purchases", tags=["purchases"])


@router.get("", response_model=PurchaseList)
def list_purchases(
    q: Annotated[str | None, Query(max_length=200)] = None,
    item_id: uuid.UUID | None = None,
    currency: Annotated[str | None, Query(pattern=r"^[A-Za-z]{3}$")] = None,
    date_from: date | None = None,
    date_to: date | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
    offset: Annotated[int, Query(ge=0)] = 0,
    sort: Literal["purchase_date_desc", "purchase_date_asc", "created_desc", "price_desc"] = (
        "purchase_date_desc"
    ),
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> PurchaseList:
    conditions = [Purchase.household_id == auth.household.id]
    if currency:
        conditions.append(Purchase.currency == currency.upper())
    if date_from is not None:
        conditions.append(Purchase.purchase_date >= date_from)
    if date_to is not None:
        conditions.append(Purchase.purchase_date <= date_to)
    if item_id is not None:
        item = db.scalar(
            select(Item.id).where(Item.id == item_id, Item.household_id == auth.household.id)
        )
        if item is None:
            raise ApiError(422, "item_not_found", "The selected item does not exist.")
        conditions.append(Purchase.items.any(Item.id == item_id))

    term = (q or "").strip()
    if term:
        search = f"%{term}%"
        conditions.append(
            or_(
                Purchase.vendor.ilike(search),
                Purchase.order_number.ilike(search),
                Purchase.notes.ilike(search),
                Purchase.items.any(Item.name.ilike(search)),
                Purchase.receipt_document.has(
                    or_(
                        Document.title.ilike(search),
                        Document.original_filename.ilike(search),
                    )
                ),
            )
        )

    total = int(db.scalar(select(func.count(Purchase.id)).where(*conditions)) or 0)
    ordering = {
        "purchase_date_desc": [
            Purchase.purchase_date.desc().nullslast(),
            Purchase.created_at.desc(),
        ],
        "purchase_date_asc": [
            Purchase.purchase_date.asc().nullslast(),
            Purchase.created_at.asc(),
        ],
        "created_desc": [Purchase.created_at.desc()],
        "price_desc": [Purchase.price_cents.desc().nullslast()],
    }[sort]
    purchases = db.scalars(
        select(Purchase)
        .options(*purchase_load_options())
        .where(*conditions)
        .order_by(*ordering)
        .limit(limit)
        .offset(offset)
    ).all()
    return PurchaseList(
        items=[purchase_out(purchase) for purchase in purchases],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.post("", response_model=PurchaseMutationResponse, status_code=201)
def create_purchase_route(
    payload: PurchaseCreate,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> PurchaseMutationResponse:
    purchase = create_purchase(db, auth.household.id, payload)
    return PurchaseMutationResponse(
        purchase=purchase_out(purchase),
        updated_item_ids=[item.id for item in purchase.items],
    )


@router.get("/{purchase_id}", response_model=PurchaseOut)
def read_purchase(
    purchase_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> PurchaseOut:
    return purchase_out(get_purchase(db, auth.household.id, purchase_id))


@router.patch("/{purchase_id}", response_model=PurchaseMutationResponse)
def update_purchase_route(
    purchase_id: uuid.UUID,
    payload: PurchaseUpdate,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> PurchaseMutationResponse:
    purchase = get_purchase(db, auth.household.id, purchase_id)
    purchase = update_purchase(db, purchase, payload)
    return PurchaseMutationResponse(
        purchase=purchase_out(purchase),
        updated_item_ids=[item.id for item in purchase.items],
    )


@router.delete("/{purchase_id}", status_code=204)
def delete_purchase_route(
    purchase_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> Response:
    purchase = get_purchase(db, auth.household.id, purchase_id)
    delete_purchase(db, purchase)
    return Response(status_code=204)
