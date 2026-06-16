"""
SigLIP-based semantic image matching (LEGACY — rollback only).

Loaded only when FINDER_VISION_MATCH=true. Default path uses match_score.py.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from io import BytesIO
from typing import Optional

import requests as req_sync
import torch
from PIL import Image
from transformers import AutoModel, AutoProcessor

logger = logging.getLogger("pricehawk.image_match_siglip")

MODEL_NAME = os.environ.get("SIGLIP_MODEL", "google/siglip-base-patch16-224")
IMAGE_TIMEOUT = int(os.environ.get("IMAGE_DOWNLOAD_TIMEOUT", "8"))
IMAGE_CHECK_MIN_TEXT = float(os.environ.get("IMAGE_CHECK_MIN_TEXT", "0.38"))
IMAGE_CHECK_MAX_TEXT = float(os.environ.get("IMAGE_CHECK_MAX_TEXT", "0.81"))
MAX_IMAGE_CANDIDATES = int(os.environ.get("FINDER_IMAGE_CANDIDATES", "5"))

_processor = None
_model = None
_model_lock = asyncio.Lock()


async def _get_model():
    global _processor, _model
    if _model is not None:
        return _processor, _model

    async with _model_lock:
        if _model is not None:
            return _processor, _model

        logger.info("[SigLIP] Loading model %s...", MODEL_NAME)
        t0 = time.time()
        loop = asyncio.get_event_loop()
        _processor, _model = await loop.run_in_executor(None, _load_model_sync)
        logger.info("[SigLIP] Model loaded in %.1fs", time.time() - t0)
        return _processor, _model


def _load_model_sync():
    processor = AutoProcessor.from_pretrained(MODEL_NAME)
    model = AutoModel.from_pretrained(MODEL_NAME)
    model.eval()
    return processor, model


def _download_image_sync(url: str, timeout: int = 8) -> Optional[Image.Image]:
    if not url or not url.startswith("http"):
        return None
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "image/webp,image/avif,image/*,*/*;q=0.8",
        }
        r = req_sync.get(url, headers=headers, timeout=timeout, stream=True)
        if r.status_code != 200:
            return None
        content_type = r.headers.get("content-type", "")
        if content_type and "image" not in content_type:
            return None
        data = b""
        for chunk in r.iter_content(1024):
            data += chunk
            if len(data) > 1_048_576:
                break
        return Image.open(BytesIO(data)).convert("RGB")
    except Exception as exc:  # noqa: BLE001
        logger.debug("[SigLIP] Image download failed %s: %s", url, exc)
        return None


async def _download_image(url: str) -> Optional[Image.Image]:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _download_image_sync, url, IMAGE_TIMEOUT)


def _embed_images_sync(processor, model, images: list[Image.Image]) -> torch.Tensor:
    inputs = processor(images=images, return_tensors="pt", padding=True)
    with torch.no_grad():
        embeddings = model.get_image_features(**inputs)
    embeddings = torch.nn.functional.normalize(embeddings, dim=-1)
    return embeddings


async def _embed_images(images: list[Image.Image]) -> Optional[torch.Tensor]:
    if not images:
        return None
    processor, model = await _get_model()
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _embed_images_sync, processor, model, images)


def cosine_similarity(a: torch.Tensor, b: torch.Tensor) -> float:
    return float(torch.dot(a, b).item())


async def image_match(
    ebay_image_url: str,
    candidates: list[dict],
    text_best_score: float,
    *,
    ebay_title: str = "",
    identifiers: Optional[dict] = None,
) -> Optional[dict]:
    del ebay_title, identifiers

    if text_best_score >= IMAGE_CHECK_MAX_TEXT:
        return None
    if text_best_score < IMAGE_CHECK_MIN_TEXT:
        return None

    ebay_img = await _download_image(ebay_image_url)
    if ebay_img is None:
        return None

    top_candidates = candidates[:MAX_IMAGE_CANDIDATES]
    candidate_image_urls = [c.get("image_url", "") for c in top_candidates]
    amazon_imgs = await asyncio.gather(*[_download_image(url) for url in candidate_image_urls])
    valid = [(i, img) for i, img in enumerate(amazon_imgs) if img is not None]
    if not valid:
        return None

    all_images = [ebay_img] + [img for _, img in valid]
    embeddings = await _embed_images(all_images)
    if embeddings is None:
        return None

    ebay_emb = embeddings[0]
    amazon_embs = embeddings[1:]

    results = []
    for rank, (orig_idx, _) in enumerate(valid):
        candidate = top_candidates[orig_idx]
        image_score = cosine_similarity(ebay_emb, amazon_embs[rank])
        text_score = float(candidate.get("text_score", 0.0))

        if text_score < 0.55:
            combined = 0.30 * text_score + 0.70 * image_score
        elif text_score < 0.68:
            combined = 0.40 * text_score + 0.60 * image_score
        else:
            combined = 0.50 * text_score + 0.50 * image_score

        results.append(
            {
                **candidate,
                "image_score": round(image_score, 4),
                "combined_score": round(combined, 4),
                "match_method": "image_siglip",
                "text_score": text_score,
            }
        )

    if not results:
        return None

    best = max(results, key=lambda r: r["combined_score"])
    accepted = (
        (best["image_score"] >= 0.85 and best["combined_score"] >= 0.72)
        or (best["text_score"] >= 0.55 and best["image_score"] >= 0.75)
        or (best["text_score"] >= 0.62 and best["image_score"] >= 0.68)
    )
    if not accepted:
        return None

    logger.info(
        "[SigLIP] Match asin=%s text=%.3f image=%.3f combined=%.3f",
        best.get("asin"),
        best["text_score"],
        best["image_score"],
        best["combined_score"],
    )
    return best


async def warmup():
    logger.info("[SigLIP] Warming up model...")
    await _get_model()
    logger.info("[SigLIP] Warmup complete")
