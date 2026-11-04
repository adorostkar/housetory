from fastapi import APIRouter

from .routes import (
    ai,
    auth,
    containers,
    documents,
    exports,
    health,
    household,
    imports,
    items,
    labels,
    locations,
    overview,
    ownership,
    purchases,
    rooms,
    taxonomy,
    warranties,
)

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(auth.router)
api_router.include_router(household.router)
api_router.include_router(overview.router)
api_router.include_router(ownership.router)
api_router.include_router(rooms.router)
api_router.include_router(locations.router)
api_router.include_router(containers.router)
api_router.include_router(labels.router)
api_router.include_router(taxonomy.router)
api_router.include_router(items.router)
api_router.include_router(documents.router)
api_router.include_router(purchases.router)
api_router.include_router(warranties.router)
api_router.include_router(exports.router)
api_router.include_router(imports.router)
api_router.include_router(ai.router)

__all__ = ["api_router"]
