FROM ghcr.io/astral-sh/uv:0.13.9@sha256:d3b601f0c7b118bc1753febf7c41cc80981df678445e0254284eecf84db79a7d AS uv

# The Debian API image has high-severity OS findings without fixed versions.
FROM ubuntu:26.04@sha256:d66b366dac61b575bee2aef07e9c26e8070096fbe84a3d4d3eb0da069b5d76db AS api
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /app
ENV PATH="/app/.venv/bin:${PATH}" UV_PYTHON_INSTALL_DIR=/opt/uv-python \
    UV_PYTHON_PREFERENCE=only-managed PYTHONDONTWRITEBYTECODE=1
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev \
    && managed_python="$(uv python find --system)" \
    && uv pip uninstall --system --break-system-packages --python "$managed_python" pip setuptools \
    && find /opt/uv-python -type f -path '*/ensurepip/_bundled/*.whl' -delete
COPY alembic.ini ./
COPY migrations ./migrations
COPY fixture ./fixture
USER 10001:10001
CMD ["uvicorn", "fixture.api:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]

FROM python:3.14.10-slim-bookworm@sha256:e60ad028afdcdd14772a3d46decf0eaf616720f9102aeb4397a2045ff6718c3d AS renderer
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /app
ENV PATH="/app/.venv/bin:${PATH}" UV_PYTHON_DOWNLOADS=never PYTHONDONTWRITEBYTECODE=1
COPY pyproject.toml uv.lock ./
# Pin the full native dependency resolution to the signed Bookworm archives.
RUN printf '%s\n' \
      'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20261120T000000Z/ bookworm main' \
      'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/20261120T000000Z/ bookworm-security main' \
      > /etc/apt/sources.list.d/renderer.list \
    && rm /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=3 update \
    && apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
      fontconfig=2.14.1-4 fonts-dejavu-core=2.37-6 \
      libpango-1.0-0=1.50.12+ds-1 libpangoft2-1.0-0=1.50.12+ds-1 \
      libharfbuzz0b=6.0.0+dfsg-3 libharfbuzz-subset0=6.0.0+dfsg-3 \
      libfreetype6 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/* \
    && uv sync --locked --no-dev --group render
COPY fixture ./fixture
USER 10001:10001
ENTRYPOINT ["python", "-m", "fixture.render"]

FROM rocker/r-ver:4.6.2@sha256:b344cf44c8cfb787d9e091cb88a9694fbc771e7600edaa7b545030babfc05bf3 AS r-base

FROM r-base AS r-packages
WORKDIR /app
ENV R_LIBS_SITE=/opt/rafiq-r RENV_CONFIG_CACHE_ENABLED=false
COPY renv.lock ./
COPY r/restore.R ./r/restore.R
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential ca-certificates \
    && mkdir -p /opt/rafiq-r \
    && Rscript --vanilla r/restore.R

FROM r-base AS worker-base
# The compiled R packages use shared libraries at runtime. Linux headers are build inputs.
RUN apt-get purge -y linux-libc-dev
COPY --from=r-packages /opt/rafiq-r /opt/rafiq-r
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /app
ENV PATH="/app/.venv/bin:${PATH}" UV_PYTHON_INSTALL_DIR=/opt/uv-python \
    UV_PYTHON_PREFERENCE=only-managed PYTHONDONTWRITEBYTECODE=1 \
    R_LIBS_SITE=/opt/rafiq-r RENV_CONFIG_CACHE_ENABLED=false
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev \
    && managed_python="$(uv python find --system)" \
    && uv pip uninstall --system --break-system-packages --python "$managed_python" pip setuptools \
    && find /opt/uv-python -type f -path '*/ensurepip/_bundled/*.whl' -delete
COPY fixture ./fixture
COPY r ./r

FROM worker-base AS worker-test
RUN uv sync --locked
COPY tests ./tests
USER 10001:10001

FROM worker-base AS worker
USER 10001:10001
CMD ["python", "-m", "fixture.worker"]
