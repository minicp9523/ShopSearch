from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Iterable


class Storage:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path)
        self.connection.row_factory = sqlite3.Row
        self.connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS query_runs (
                id INTEGER PRIMARY KEY,
                cache_key TEXT NOT NULL,
                query TEXT NOT NULL,
                server TEXT NOT NULL,
                store_type TEXT NOT NULL,
                status TEXT NOT NULL,
                result_count INTEGER NOT NULL DEFAULT 0,
                error TEXT,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_query_runs_cache_time
            ON query_runs(cache_key, created_at);

            CREATE TABLE IF NOT EXISTS listings (
                fingerprint TEXT PRIMARY KEY,
                cache_key TEXT NOT NULL,
                query TEXT NOT NULL,
                shop_name TEXT NOT NULL,
                item_name TEXT NOT NULL,
                slot TEXT NOT NULL,
                unit_price TEXT NOT NULL,
                quantity TEXT NOT NULL,
                trade_type TEXT NOT NULL,
                raw_json TEXT NOT NULL,
                first_seen_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS notifications (
                cache_key TEXT PRIMARY KEY,
                last_price INTEGER NOT NULL,
                notified_at TEXT NOT NULL
            );
            """
        )
        self.connection.commit()

    @staticmethod
    def cache_key(server: str, store_type: str, query: str) -> str:
        normalized = "|".join((server.strip(), store_type.strip(), query.strip().casefold()))
        return hashlib.sha256(normalized.encode("utf-8")).hexdigest()

    def is_fresh(self, cache_key: str, ttl_minutes: int) -> bool:
        cutoff = (datetime.now(UTC) - timedelta(minutes=ttl_minutes)).isoformat()
        row = self.connection.execute(
            """
            SELECT 1 FROM query_runs
            WHERE cache_key = ? AND status = 'success' AND created_at >= ?
            LIMIT 1
            """,
            (cache_key, cutoff),
        ).fetchone()
        return row is not None

    def queries_today(self) -> int:
        today = datetime.now(UTC).date().isoformat()
        row = self.connection.execute(
            "SELECT COUNT(*) AS count FROM query_runs WHERE substr(created_at, 1, 10) = ?",
            (today,),
        ).fetchone()
        return int(row["count"])

    def notification_due(self, cache_key: str, price: int, cooldown_minutes: int) -> bool:
        row = self.connection.execute(
            "SELECT last_price, notified_at FROM notifications WHERE cache_key = ?",
            (cache_key,),
        ).fetchone()
        if row is None:
            return True
        if price < int(row["last_price"]):
            return True
        notified_at = datetime.fromisoformat(row["notified_at"])
        return datetime.now(UTC) - notified_at >= timedelta(minutes=cooldown_minutes)

    def record_notification(self, cache_key: str, price: int) -> None:
        with self.connection:
            self.connection.execute(
                """
                INSERT INTO notifications (cache_key, last_price, notified_at)
                VALUES (?, ?, ?)
                ON CONFLICT(cache_key) DO UPDATE SET
                    last_price = excluded.last_price,
                    notified_at = excluded.notified_at
                """,
                (cache_key, price, datetime.now(UTC).isoformat()),
            )

    def save_success(
        self,
        cache_key: str,
        query: str,
        server: str,
        store_type: str,
        rows: Iterable[dict[str, str]],
    ) -> tuple[int, int]:
        now = datetime.now(UTC).isoformat()
        rows = list(rows)
        inserted = 0
        with self.connection:
            for row in rows:
                raw = json.dumps(row, ensure_ascii=False, sort_keys=True)
                fingerprint = hashlib.sha256(raw.encode("utf-8")).hexdigest()
                cursor = self.connection.execute(
                    """
                    INSERT OR IGNORE INTO listings (
                        fingerprint, cache_key, query, shop_name, item_name, slot,
                        unit_price, quantity, trade_type, raw_json, first_seen_at, last_seen_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        fingerprint,
                        cache_key,
                        query,
                        row.get("商店名稱", ""),
                        row.get("道具名稱", ""),
                        row.get("slot", ""),
                        row.get("單價", ""),
                        row.get("數量", ""),
                        row.get("收購/販售", ""),
                        raw,
                        now,
                        now,
                    ),
                )
                inserted += cursor.rowcount
                if cursor.rowcount == 0:
                    self.connection.execute(
                        "UPDATE listings SET last_seen_at = ? WHERE fingerprint = ?",
                        (now, fingerprint),
                    )
            self.connection.execute(
                """
                INSERT INTO query_runs
                    (cache_key, query, server, store_type, status, result_count, created_at)
                VALUES (?, ?, ?, ?, 'success', ?, ?)
                """,
                (cache_key, query, server, store_type, len(rows), now),
            )
        return len(rows), inserted

    def save_error(
        self, cache_key: str, query: str, server: str, store_type: str, error: str
    ) -> None:
        with self.connection:
            self.connection.execute(
                """
                INSERT INTO query_runs
                    (cache_key, query, server, store_type, status, error, created_at)
                VALUES (?, ?, ?, ?, 'error', ?, ?)
                """,
                (cache_key, query, server, store_type, error, datetime.now(UTC).isoformat()),
            )
