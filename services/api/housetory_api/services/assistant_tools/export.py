"""Write the assistant's tool catalogue as JSON, for people and tools to inspect.

    python -m housetory_api.services.assistant_tools.export [path]

The image build runs this. The file is made from the tool registrations, like the
catalogue the model is given and ``GET /api/v1/assistant/tools``. It is never edited by
hand and it needs no database: what is available to a user is only known at run time.
"""

import json
import sys
from pathlib import Path

from .registry import catalogue


def export() -> str:
    return json.dumps(catalogue(), indent=2, ensure_ascii=False, sort_keys=True) + "\n"


def main(arguments: list[str]) -> int:
    if len(arguments) > 1:
        print(__doc__, file=sys.stderr)
        return 2
    text = export()
    if arguments:
        Path(arguments[0]).write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
