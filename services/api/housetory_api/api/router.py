from fastapi import APIRouter, Depends

from .deps import enforce_household_context, enforce_household_write_access
from .routes import (
    accounts,
    ai,
    ai_settings,
    auth,
    borrowed,
    bulk,
    containers,
    documents,
    entity_photos,
    evidence_exports,
    exports,
    extraction,
    health,
    household,
    households,
    imports,
    inventory_review,
    item_images,
    items,
    labels,
    loans,
    locations,
    manuals,
    online_search,
    overview,
    ownership,
    place_management,
    properties,
    purchases,
    rooms,
    scans,
    search,
    stocktake,
    system,
    taxonomy,
    voice,
    warranties,
)

api_router = APIRouter()
write_guard = [
    Depends(enforce_household_context),
    Depends(enforce_household_write_access),
]
api_router.include_router(health.router)
api_router.include_router(auth.router)
api_router.include_router(accounts.router)
api_router.include_router(households.router)
api_router.include_router(online_search.router, dependencies=write_guard)
api_router.include_router(place_management.router, dependencies=write_guard)
api_router.include_router(inventory_review.router, dependencies=write_guard)
api_router.include_router(household.router, dependencies=write_guard)
api_router.include_router(overview.router)
api_router.include_router(ownership.router)
api_router.include_router(properties.router, dependencies=write_guard)
api_router.include_router(rooms.router, dependencies=write_guard)
api_router.include_router(search.router)
api_router.include_router(locations.router, dependencies=write_guard)
api_router.include_router(containers.router, dependencies=write_guard)
api_router.include_router(labels.router, dependencies=write_guard)
api_router.include_router(taxonomy.router, dependencies=write_guard)
api_router.include_router(items.router, dependencies=write_guard)
api_router.include_router(item_images.router, dependencies=write_guard)
api_router.include_router(bulk.router, dependencies=write_guard)
api_router.include_router(loans.router, dependencies=write_guard)
api_router.include_router(manuals.router, dependencies=write_guard)
api_router.include_router(scans.router, dependencies=write_guard)
api_router.include_router(extraction.router, dependencies=write_guard)
api_router.include_router(documents.router, dependencies=write_guard)
api_router.include_router(purchases.router, dependencies=write_guard)
api_router.include_router(warranties.router, dependencies=write_guard)
api_router.include_router(exports.router, dependencies=write_guard)
api_router.include_router(evidence_exports.router, dependencies=write_guard)
api_router.include_router(stocktake.router, dependencies=write_guard)
api_router.include_router(imports.router, dependencies=write_guard)
api_router.include_router(voice.router, dependencies=write_guard)
api_router.include_router(ai.router, dependencies=write_guard)
api_router.include_router(borrowed.router, dependencies=write_guard)
api_router.include_router(ai_settings.router, dependencies=write_guard)
api_router.include_router(system.router, dependencies=write_guard)
api_router.include_router(entity_photos.router, dependencies=write_guard)

__all__ = ["api_router"]
