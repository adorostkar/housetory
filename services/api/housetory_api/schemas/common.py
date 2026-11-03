import uuid
from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, StringConstraints


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


def trimmed(min_length: int, max_length: int) -> type[str]:
    return Annotated[
        str,
        StringConstraints(strip_whitespace=True, min_length=min_length, max_length=max_length),
    ]


Name = trimmed(1, 120)
Description = Annotated[str, StringConstraints(strip_whitespace=True, max_length=4000)]


class Message(BaseModel):
    message: str


class Timestamped(ORMModel):
    id: uuid.UUID
    created_at: datetime
    updated_at: datetime
