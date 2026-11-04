from fastapi import APIRouter

from .routes import (
    auth,
    documents,
    exports,
    health,
    household,
    items,
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
api_router.include_router(taxonomy.router)
api_router.include_router(items.router)
api_router.include_router(documents.router)
api_router.include_router(purchases.router)
api_router.include_router(warranties.router)
api_router.include_router(exports.router)

__all__ = ["api_router"]
