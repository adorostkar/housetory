import uuid

from fastapi import APIRouter, Depends, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ...db import get_db
from ...models import Category, Item, Tag, item_tags
from ...schemas.taxonomy import (
    CategoryCreate,
    CategoryList,
    CategoryOut,
    CategoryUpdate,
    TagCreate,
    TagList,
    TagOut,
    TagUpdate,
)
from ..deps import AuthContext, require_auth
from ..errors import ApiError

router = APIRouter(tags=["taxonomy"])


def _category(db: Session, household_id: uuid.UUID, category_id: uuid.UUID) -> Category:
    category = db.scalar(
        select(Category).where(Category.id == category_id, Category.household_id == household_id)
    )
    if category is None:
        raise ApiError(404, "category_not_found", "Category not found.")
    return category


def _validate_category_parent(
    db: Session,
    household_id: uuid.UUID,
    parent_id: uuid.UUID | None,
    *,
    category_id: uuid.UUID | None = None,
) -> None:
    if parent_id is None:
        return
    if category_id is not None and parent_id == category_id:
        raise ApiError(422, "category_cycle", "A category cannot be its own parent.")
    cursor: Category | None = _category(db, household_id, parent_id)
    while cursor is not None:
        if category_id is not None and cursor.id == category_id:
            raise ApiError(422, "category_cycle", "That would create a category loop.")
        cursor = db.get(Category, cursor.parent_id) if cursor.parent_id else None


def _ensure_unique_category(
    db: Session,
    household_id: uuid.UUID,
    name: str,
    parent_id: uuid.UUID | None,
    *,
    exclude_id: uuid.UUID | None = None,
) -> None:
    query = select(Category.id).where(
        Category.household_id == household_id,
        func.lower(Category.name) == name.lower(),
    )
    if parent_id is None:
        query = query.where(Category.parent_id.is_(None))
    else:
        query = query.where(Category.parent_id == parent_id)
    if exclude_id is not None:
        query = query.where(Category.id != exclude_id)
    if db.scalar(query) is not None:
        raise ApiError(409, "category_name_taken", "A category with this name already exists.")


def _category_out(category: Category, counts: dict) -> CategoryOut:
    return CategoryOut(
        id=category.id,
        name=category.name,
        parent_id=category.parent_id,
        color=category.color,
        description=category.description,
        sort_order=category.sort_order,
        item_count=counts.get(category.id, 0),
        created_at=category.created_at,
        updated_at=category.updated_at,
    )


@router.get("/categories", response_model=CategoryList)
def list_categories(
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> CategoryList:
    categories = db.scalars(
        select(Category)
        .where(Category.household_id == auth.household.id)
        .order_by(Category.sort_order, func.lower(Category.name))
    ).all()
    counts = dict(
        db.execute(
            select(Item.category_id, func.count(Item.id))
            .where(Item.household_id == auth.household.id, Item.category_id.is_not(None))
            .group_by(Item.category_id)
        ).all()
    )
    return CategoryList(items=[_category_out(c, counts) for c in categories])


@router.post("/categories", response_model=CategoryOut, status_code=201)
def create_category(
    payload: CategoryCreate,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> CategoryOut:
    _validate_category_parent(db, auth.household.id, payload.parent_id)
    _ensure_unique_category(db, auth.household.id, payload.name, payload.parent_id)
    category = Category(
        household_id=auth.household.id,
        parent_id=payload.parent_id,
        name=payload.name,
        color=payload.color,
        description=payload.description,
        sort_order=payload.sort_order,
    )
    db.add(category)
    db.commit()
    return _category_out(category, {})


@router.patch("/categories/{category_id}", response_model=CategoryOut)
def update_category(
    category_id: uuid.UUID,
    payload: CategoryUpdate,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> CategoryOut:
    category = _category(db, auth.household.id, category_id)
    fields = payload.model_fields_set
    new_parent_id = payload.parent_id if "parent_id" in fields else category.parent_id
    if "parent_id" in fields:
        _validate_category_parent(db, auth.household.id, new_parent_id, category_id=category.id)
    if (payload.name is not None and payload.name != category.name) or (
        "parent_id" in fields and new_parent_id != category.parent_id
    ):
        _ensure_unique_category(
            db,
            auth.household.id,
            payload.name if payload.name is not None else category.name,
            new_parent_id,
            exclude_id=category.id,
        )
    if payload.name is not None:
        category.name = payload.name
    if "parent_id" in fields:
        category.parent_id = new_parent_id
    if "color" in fields:
        category.color = payload.color
    if "description" in fields:
        category.description = payload.description
    if payload.sort_order is not None:
        category.sort_order = payload.sort_order
    db.commit()
    counts = dict(
        db.execute(
            select(Item.category_id, func.count(Item.id))
            .where(Item.household_id == auth.household.id, Item.category_id == category.id)
            .group_by(Item.category_id)
        ).all()
    )
    return _category_out(category, counts)


@router.delete("/categories/{category_id}", status_code=204)
def delete_category(
    category_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> Response:
    category = _category(db, auth.household.id, category_id)
    db.delete(category)
    db.commit()
    return Response(status_code=204)


def _tag(db: Session, household_id: uuid.UUID, tag_id: uuid.UUID) -> Tag:
    tag = db.scalar(select(Tag).where(Tag.id == tag_id, Tag.household_id == household_id))
    if tag is None:
        raise ApiError(404, "tag_not_found", "Tag not found.")
    return tag


@router.get("/tags", response_model=TagList)
def list_tags(
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> TagList:
    tags = db.scalars(
        select(Tag).where(Tag.household_id == auth.household.id).order_by(func.lower(Tag.name))
    ).all()
    counts = dict(
        db.execute(
            select(item_tags.c.tag_id, func.count(item_tags.c.item_id)).group_by(item_tags.c.tag_id)
        ).all()
    )
    return TagList(
        items=[
            TagOut(
                id=tag.id,
                name=tag.name,
                created_at=tag.created_at,
                item_count=counts.get(tag.id, 0),
            )
            for tag in tags
        ]
    )


@router.post("/tags", response_model=TagOut, status_code=201)
def create_tag(
    payload: TagCreate,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> TagOut:
    existing = db.scalar(
        select(Tag).where(
            Tag.household_id == auth.household.id,
            func.lower(Tag.name) == payload.name.lower(),
        )
    )
    if existing is not None:
        raise ApiError(409, "tag_name_taken", "A tag with this name already exists.")
    tag = Tag(household_id=auth.household.id, name=payload.name)
    db.add(tag)
    db.commit()
    return TagOut(id=tag.id, name=tag.name, created_at=tag.created_at, item_count=0)


@router.patch("/tags/{tag_id}", response_model=TagOut)
def update_tag(
    tag_id: uuid.UUID,
    payload: TagUpdate,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> TagOut:
    tag = _tag(db, auth.household.id, tag_id)
    conflict = db.scalar(
        select(Tag.id).where(
            Tag.household_id == auth.household.id,
            func.lower(Tag.name) == payload.name.lower(),
            Tag.id != tag.id,
        )
    )
    if conflict is not None:
        raise ApiError(409, "tag_name_taken", "A tag with this name already exists.")
    tag.name = payload.name
    db.commit()
    count = int(
        db.scalar(select(func.count()).select_from(item_tags).where(item_tags.c.tag_id == tag.id))
        or 0
    )
    return TagOut(id=tag.id, name=tag.name, created_at=tag.created_at, item_count=count)


@router.delete("/tags/{tag_id}", status_code=204)
def delete_tag(
    tag_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> Response:
    tag = _tag(db, auth.household.id, tag_id)
    db.delete(tag)
    db.commit()
    return Response(status_code=204)
