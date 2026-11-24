from sqlalchemy import text

from app.database import engine
from app.migrate import migrate, migrate_if_needed, schema_fingerprint


def test_startup_skips_migration_when_schema_matches():
    migrate(verbose=False)
    assert migrate_if_needed() == {"skipped": True}


def test_startup_migrates_again_when_fingerprint_changes():
    with engine.begin() as conn:
        conn.execute(text("UPDATE app_schema_state SET value = 'old' WHERE key = 'schema'"))
    report = migrate_if_needed()
    assert "skipped" not in report
    with engine.connect() as conn:
        assert conn.execute(text("SELECT value FROM app_schema_state WHERE key = 'schema'")).scalar() == schema_fingerprint()
