from fastapi import APIRouter, Depends

from .deps import enforce_household_write_access
from .routes import (
    accounts,
    ai,
    ai_settings,
    auth,
    containers,
    documents,
    entity_photos,
    exports,
    health,
    household,
    imports,
    items,
    labels,
    loans,
    locations,
    overview,
    ownership,
    purchases,
    rooms,
    search,
    taxonomy,
    voice,
    warranties,
)

api_router = APIRouter()
write_guard = [Depends(enforce_household_write_access)]
api_router.include_router(health.router)
api_router.include_router(auth.router)
api_router.include_router(accounts.router)
api_router.include_router(household.router, dependencies=write_guard)
api_router.include_router(overview.router)
api_router.include_router(ownership.router)
api_router.include_router(rooms.router, dependencies=write_guard)
api_router.include_router(search.router)
api_router.include_router(locations.router, dependencies=write_guard)
api_router.include_router(containers.router, dependencies=write_guard)
api_router.include_router(labels.router, dependencies=write_guard)
api_router.include_router(taxonomy.router, dependencies=write_guard)
api_router.include_router(items.router, dependencies=write_guard)
api_router.include_router(loans.router, dependencies=write_guard)
api_router.include_router(documents.router, dependencies=write_guard)
api_router.include_router(purchases.router, dependencies=write_guard)
api_router.include_router(warranties.router, dependencies=write_guard)
api_router.include_router(exports.router, dependencies=write_guard)
api_router.include_router(imports.router, dependencies=write_guard)
api_router.include_router(voice.router, dependencies=write_guard)
api_router.include_router(ai.router, dependencies=write_guard)
api_router.include_router(ai_settings.router, dependencies=write_guard)
api_router.include_router(entity_photos.router, dependencies=write_guard)

__all__ = ["api_router"]
