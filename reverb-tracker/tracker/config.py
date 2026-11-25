"""Configuration from environment variables and an optional config.json.

Precedence: environment variable > config.json > default.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent


@dataclass
class Config:
    host: str = "127.0.0.1"
    port: int = 8765
    check_interval_hours: float = 6.0      # 0 disables auto-checks
    currency: str = "USD"
    region: str = "US_CON"                 # Reverb shipping region code
    country_code: str = "US"               # for Reverb price-guide estimates
    reverb_token: str = ""                 # optional personal access token
    password: str = ""                     # optional basic-auth password
    username: str = "admin"
    db_path: str = str(APP_DIR / "data" / "tracker.db")
    open_browser: bool = True
    request_interval: float = 1.0          # seconds between Reverb requests
    sold_lookup_groups: int = 8            # models per search that get sold-price lookups
    extra: dict = field(default_factory=dict)


# (config attribute, env var names, type)
_FIELDS = [
    ("host", ["RT_HOST", "HOST"], str),
    ("port", ["RT_PORT", "PORT"], int),
    ("check_interval_hours", ["RT_CHECK_INTERVAL_HOURS"], float),
    ("currency", ["RT_CURRENCY"], str),
    ("region", ["RT_REGION"], str),
    ("country_code", ["RT_COUNTRY"], str),
    ("reverb_token", ["REVERB_TOKEN", "RT_REVERB_TOKEN"], str),
    ("password", ["RT_PASSWORD", "APP_PASSWORD"], str),
    ("username", ["RT_USERNAME"], str),
    ("db_path", ["RT_DB_PATH"], str),
    ("open_browser", ["RT_OPEN_BROWSER"], bool),
    ("request_interval", ["RT_REQUEST_INTERVAL"], float),
    ("sold_lookup_groups", ["RT_SOLD_LOOKUP_GROUPS"], int),
]


def _coerce(value, typ):
    if typ is bool:
        if isinstance(value, bool):
            return value
        return str(value).strip().lower() in ("1", "true", "yes", "on")
    return typ(value)


def load_config(path: str | os.PathLike | None = None, env: dict | None = None) -> Config:
    env = os.environ if env is None else env
    cfg = Config()
    file_path = Path(path or env.get("RT_CONFIG") or APP_DIR / "config.json")
    file_values = {}
    if file_path.exists():
        file_values = json.loads(file_path.read_text(encoding="utf-8"))
    for attr, env_names, typ in _FIELDS:
        if attr in file_values:
            setattr(cfg, attr, _coerce(file_values[attr], typ))
        for name in env_names:
            if env.get(name) not in (None, ""):
                setattr(cfg, attr, _coerce(env[name], typ))
                break
    # Hosted platforms (Render, Railway) set PORT and need to listen publicly.
    if env.get("PORT") and not env.get("RT_HOST") and "host" not in file_values:
        cfg.host = "0.0.0.0"
        cfg.open_browser = False
    return cfg
