from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from traceline import __version__
from traceline.config import settings
from traceline.routes import health, sessions, strategy


def create_app() -> FastAPI:
    app = FastAPI(
        title="TraceLine API",
        version=__version__,
        description="F1 race replay and analytics backend.",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    # RaceData blobs are ~6MB raw, ~1.5MB gzipped — see CLAUDE.md §6.2.
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    app.include_router(health.router)
    app.include_router(sessions.router)
    app.include_router(strategy.router)
    return app


app = create_app()
