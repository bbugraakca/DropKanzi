import os
from typing import Iterable

_model = None


def _load_model():
    global _model
    if _model is not None:
        return _model
    from sentence_transformers import SentenceTransformer  # type: ignore

    model_name = os.getenv("FINDER_EMBED_MODEL", "all-MiniLM-L6-v2")
    _model = SentenceTransformer(model_name)
    return _model


def embed_texts(texts: Iterable[str]) -> list[list[float]]:
    model = _load_model()
    vecs = model.encode(list(texts), normalize_embeddings=True)
    return [list(map(float, row)) for row in vecs]


def semantic_cosine(a: str, b: str) -> float:
    va, vb = embed_texts([a, b])
    return float(sum(x * y for x, y in zip(va, vb)))
