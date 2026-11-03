from fastapi import APIRouter

from .routes import auth, health, household, items, locations, overview, rooms, taxonomy

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(auth.router)
api_router.include_router(household.router)
api_router.include_router(overview.router)
api_router.include_router(rooms.router)
api_router.include_router(locations.router)
api_router.include_router(taxonomy.router)
api_router.include_router(items.router)

__all__ = ["api_router"]
