import json
import os
from typing import Any

import psycopg2
from psycopg2.extras import RealDictCursor

from semantic import embed_texts

_conn = None


def _db():
    global _conn
    if _conn is not None:
        return _conn
    dsn = os.getenv("VECTOR_CACHE_DATABASE_URL") or os.getenv("DATABASE_URL")
    if not dsn:
        return None
    try:
        _conn = psycopg2.connect(dsn)
        _conn.autocommit = True
    except Exception:
        _conn = None
    return _conn


def lookup_similar(title: str, min_cosine: float = 0.93) -> dict[str, Any] | None:
    conn = _db()
    if not conn:
        return None
    vec = embed_texts([title])[0]
    vtxt = "[" + ",".join(f"{x:.8f}" for x in vec) + "]"
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """
            SELECT asin, amazon_title, confidence, is_negative,
                   1 - (embedding <=> %s::vector) AS cosine
            FROM match_vector_cache
            ORDER BY embedding <=> %s::vector
            LIMIT 3
            """,
            (vtxt, vtxt),
        )
        rows = cur.fetchall()
    for row in rows:
        if row.get("is_negative"):
            continue
        if float(row.get("cosine") or 0) >= min_cosine:
            return dict(row)
    return None


def save_match(title: str, asin: str, amazon_title: str, confidence: float, source: str) -> None:
    conn = _db()
    if not conn:
        return
    vec = embed_texts([title])[0]
    vtxt = "[" + ",".join(f"{x:.8f}" for x in vec) + "]"
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO match_vector_cache (embedding, asin, amazon_title, confidence, source, is_negative)
            VALUES (%s::vector, %s, %s, %s, %s, false)
            """,
            (vtxt, asin, amazon_title, confidence, source),
        )


def set_negative(title: str, asin: str) -> None:
    conn = _db()
    if not conn:
        return
    vec = embed_texts([title])[0]
    vtxt = "[" + ",".join(f"{x:.8f}" for x in vec) + "]"
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO match_vector_cache (embedding, asin, amazon_title, confidence, source, is_negative)
            VALUES (%s::vector, %s, %s, %s, %s, true)
            """,
            (vtxt, asin, json.dumps({"negative": True}), 0.0, "feedback"),
        )
