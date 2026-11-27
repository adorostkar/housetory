import uuid
from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


def trimmed(min_length: int, max_length: int) -> type[str]:
    return Annotated[
        str,
        StringConstraints(strip_whitespace=True, min_length=min_length, max_length=max_length),
    ]


Name = trimmed(1, 120)
# An opaque id that a browser makes: one for each person on each device.
DraftWriter = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{8,64}$")]
# The revision of a kept review draft that a correction was made on.
DraftRevision = Annotated[int, Field(ge=0, le=2_000_000_000)]
Description = Annotated[str, StringConstraints(strip_whitespace=True, max_length=4000)]


class Message(BaseModel):
    message: str


class Timestamped(ORMModel):
    id: uuid.UUID
    created_at: datetime
    updated_at: datetime


class ItemReference(ORMModel):
    id: uuid.UUID
    name: str
