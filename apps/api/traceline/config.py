from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    api_port: int = 8000
    redis_url: str = "redis://localhost:6379/0"
    fastf1_cache_dir: Path = Path(".fastf1-cache")
    # Disk cache for the assembled RaceData blob — keyed by
    # (year, round, session_type, data_source). One gz-compressed JSON
    # file per session. Hit = instant; miss = full 1–3 min cold build.
    racedata_cache_dir: Path = Path(".racedata-cache")
    cors_origins: list[str] = ["http://localhost:3000", "http://localhost:3001"]
    # "fastf1" (default upstream) or "openf1" (HTTP fallback). FastF1 is
    # currently blocked by F1's CloudFront IP filter; flip to "openf1" via
    # the DATA_SOURCE env var when that's the case.
    data_source: str = "openf1"


settings = Settings()
settings.fastf1_cache_dir.mkdir(parents=True, exist_ok=True)
settings.racedata_cache_dir.mkdir(parents=True, exist_ok=True)
