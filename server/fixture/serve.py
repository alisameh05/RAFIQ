"""Start the fixture API on the port assigned by its runtime."""

import os


def server_port(value: str | None) -> int:
    if value is None:
        return 8000
    if not value.isascii() or not value.isdecimal():
        raise ValueError("PORT must be a decimal TCP port")
    port = int(value)
    if not 1 <= port <= 65535:
        raise ValueError("PORT must be between 1 and 65535")
    return port


def main() -> None:
    port = server_port(os.environ.get("PORT"))
    os.execvp(
        "uvicorn",
        ["uvicorn", "fixture.api:app", "--host", "0.0.0.0", "--port", str(port), "--no-access-log"],
    )


if __name__ == "__main__":
    main()
