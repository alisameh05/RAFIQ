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
    surface = os.environ.get("RAFIQ_API_SURFACE", "fixture")
    if surface == "accounts":
        target = ["fixture.accounts:from_environment", "--factory"]
    elif surface == "fixture":
        target = ["fixture.api:app"]
    else:
        raise ValueError("Unknown RAFIQ API surface")
    os.execvp(
        "uvicorn",
        ["uvicorn", *target, "--host", "0.0.0.0", "--port", str(port), "--no-access-log"],
    )


if __name__ == "__main__":
    main()
