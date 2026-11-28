from datetime import datetime

from pydantic import BaseModel, Field

from .auth import HouseholdOut, UserOut
from .containers import ContainerList
from .items import ItemDetail
from .lending import LoanListOut
from .locations import StorageLocationList
from .overview import OverviewOut
from .properties import PropertyList
from .rooms import RoomList
from .taxonomy import CategoryList, TagList

SNAPSHOT_VERSION = 1


class OfflineSnapshot(BaseModel):
    """Everything a device needs to show one household without the server.

    Each part has the same shape as the API response it stands in for, so the
    web app can answer its normal read requests from this copy.
    """

    version: int = SNAPSHOT_VERSION
    generated_at: datetime
    user: UserOut
    household: HouseholdOut
    role: str
    properties: PropertyList
    rooms: RoomList
    locations: StorageLocationList
    categories: CategoryList
    tags: TagList
    containers: ContainerList
    items: list[ItemDetail] = Field(default_factory=list)
    loans: LoanListOut
    overview: OverviewOut


__all__ = ["SNAPSHOT_VERSION", "OfflineSnapshot"]
