"""
SubAI Relay — personal, free middle layer between the Premiere plugin and the
existing Whisper worker on Modal (subai-whisper / WhisperTranscriber).

It replaces AWS S3 + Vercel + Supabase + Claude for personal use:

    Premiere plugin ──(audio in 4 MB chunks)──▶ subai-relay (CPU, almost free)
                                                    │ audio_url (one-time link)
                                                    ▼
                                        subai-whisper (your existing GPU worker,
                                        unchanged — it downloads audio_url)
                                                    │ segments + words
    Premiere plugin ◀──(poll /job/<id>)──────── subai-relay keeps the result

Audio and results live in a private modal.Dict and are deleted as soon as
the job ends / the plugin has placed the captions. Nothing is sent to any AI
for correction — the plugin gets Whisper's output exactly as it came back.

One-time setup (Windows CMD, in the folder of this file):

    python -m modal secret create subai-relay SUBAI_TOKEN=<your-password> WHISPER_URL=<your whisper endpoint URL>
    python -m modal deploy subai_relay.py

The deploy prints the relay URL, e.g.
    https://<workspace>--subai-relay-web.modal.run
Paste that URL and the same password into the plugin's ⚙️ settings tab.
"""

import modal

APP_NAME = "subai-relay"
CHUNK_SIZE = 4 * 1024 * 1024            # 4 MiB per stored piece (Dict-friendly)
MAX_UPLOAD = 1024 * 1024 * 1024         # 1 GiB hard cap per file
JOB_MAX_AGE = 75 * 60                   # a job still "running" after this is reported as failed
ALLOWED_LANGS = {"he", "en", "ar", "ru", "auto"}

# Same initial_prompt the old Vercel route sent to Whisper (process/route.ts).
HE_PROMPT = (
    "שלום, זהו תמלול מקצועי בעברית תקנית. סימני פיסוק: נקודה, פסיק, סימן שאלה. "
    "קיצורים: רמב\"ם, רש\"י, צה\"ל, בג\"ץ, ד\"ר, עו\"ד. "
    "ביטויים: ברוך השם, בעזרת השם, חס ושלום, יישר כוח."
)

app = modal.App(APP_NAME)
image = modal.Image.debian_slim(python_version="3.11").pip_install(
    "fastapi[standard]>=0.110", "requests>=2.31"
)
store = modal.Dict.from_name("subai-relay-store", create_if_missing=True)
secret = modal.Secret.from_name("subai-relay")


def k_job(job_id: str) -> str:
    return f"job:{job_id}"


def k_res(job_id: str) -> str:
    return f"res:{job_id}"


def k_call(job_id: str) -> str:
    return f"call:{job_id}"


def k_chunk(job_id: str, i: int) -> str:
    return f"audio:{job_id}:{i}"


def n_chunks(size: int) -> int:
    return (int(size) + CHUNK_SIZE - 1) // CHUNK_SIZE


# ═══════════════════════════════════════════════════════════════════
# Background job — calls the existing Whisper worker and stores result
# ═══════════════════════════════════════════════════════════════════

@app.function(image=image, secrets=[secret], timeout=3600, memory=512)
def run_job(job_id: str, audio_url: str, lang: str):
    import os
    import time

    import requests

    def update(**fields):
        job = store.get(k_job(job_id))
        if job is None:          # deleted / cancelled meanwhile
            return
        job.update(fields)
        job["updated"] = time.time()
        store[k_job(job_id)] = job

    def delete_audio():
        job = store.get(k_job(job_id)) or {}
        for i in range(n_chunks(job.get("size", 0))):
            store.pop(k_chunk(job_id, i), None)

    whisper_url = os.environ.get("WHISPER_URL", "").strip()
    if not whisper_url:
        update(status="failed", error="WHISPER_URL חסר ב-Modal secret בשם subai-relay")
        delete_audio()
        return

    body = {
        "audio_url": audio_url,
        "lang": lang or "he",
        "beam_size": 5,
        "best_of": 5,
        "vad_filter": True,
    }
    if lang == "he":
        body["initial_prompt"] = HE_PROMPT

    update(status="transcribing")
    t0 = time.time()
    try:
        # Modal web endpoints answer long requests with 303 redirects;
        # requests follows them automatically (up to 30 × 150 s).
        r = requests.post(whisper_url, json=body, timeout=(30, 3600))
        if r.status_code != 200:
            update(status="failed", error=f"Whisper HTTP {r.status_code}: {r.text[:300]}")
            return
        data = r.json()
        if not isinstance(data, dict):
            update(status="failed", error="Whisper החזיר תשובה לא תקינה")
            return
        if data.get("error"):
            update(status="failed", error=f"Whisper: {str(data['error'])[:300]}")
            return
        if store.get(k_job(job_id)) is None:    # cancelled while transcribing
            return
        store[k_res(job_id)] = data
        update(status="done", whisper_sec=round(time.time() - t0, 1))
    except Exception as e:  # noqa: BLE001 — report anything back to the plugin
        update(status="failed", error=f"{type(e).__name__}: {e}"[:400])
    finally:
        delete_audio()


# ═══════════════════════════════════════════════════════════════════
# Web API used by the plugin (and by the Whisper worker for /audio)
# ═══════════════════════════════════════════════════════════════════

@app.function(image=image, secrets=[secret], timeout=600, memory=512, scaledown_window=60)
@modal.concurrent(max_inputs=50)
@modal.asgi_app()
def web():
    import hmac
    import os
    import secrets as pysecrets
    import time

    from fastapi import FastAPI, HTTPException, Request
    from fastapi.responses import StreamingResponse

    token = os.environ.get("SUBAI_TOKEN", "")
    api = FastAPI(title="SubAI Relay", docs_url=None, redoc_url=None, openapi_url=None)

    def check(request: Request):
        sent = request.headers.get("x-subai-token", "")
        if not token or not hmac.compare_digest(sent.encode(), token.encode()):
            raise HTTPException(status_code=401, detail="סיסמה שגויה")

    async def get_job(job_id: str):
        if not job_id or len(job_id) > 64:
            return None
        return await store.get.aio(k_job(job_id))

    async def put_job(job_id: str, job: dict):
        job["updated"] = time.time()
        await store.put.aio(k_job(job_id), job)

    async def wipe(job_id: str, job: dict | None):
        size = (job or {}).get("size", 0)
        for i in range(n_chunks(size)):
            await store.pop.aio(k_chunk(job_id, i), None)
        for key in (k_res(job_id), k_call(job_id), k_job(job_id)):
            await store.pop.aio(key, None)

    base_cache: dict = {}

    async def public_base(request: Request) -> str:
        """Public https address of this relay — the Whisper worker downloads audio from it."""
        override = os.environ.get("RELAY_PUBLIC_URL", "").strip().rstrip("/")
        if override:
            return override
        if "url" in base_cache:
            return base_cache["url"]
        host = request.headers.get("x-forwarded-host") or request.headers.get("host", "")
        url = f"https://{host}" if host.endswith(".modal.run") else ""
        if not url:
            try:
                url = (await modal.Function.from_name(APP_NAME, "web").get_web_url.aio() or "").rstrip("/")
            except Exception:  # noqa: BLE001
                url = ""
        url = url or f"https://{host}"
        base_cache["url"] = url
        return url

    # ── health / settings test ──
    @api.get("/ping")
    async def ping(request: Request):
        check(request)
        return {"ok": True, "whisper_url_set": bool(os.environ.get("WHISPER_URL", "").strip())}

    # ── 1. start an upload ──
    @api.post("/upload")
    async def upload_start(request: Request, size: int, lang: str = "he"):
        check(request)
        if lang not in ALLOWED_LANGS:
            raise HTTPException(400, "שפה לא נתמכת")
        if size < 1000:
            raise HTTPException(400, "קובץ האודיו ריק")
        if size > MAX_UPLOAD:
            raise HTTPException(413, "קובץ האודיו גדול מדי")
        job_id = pysecrets.token_urlsafe(24)   # 192-bit id — also the audio link secret
        now = time.time()
        await put_job(job_id, {
            "status": "uploading", "size": int(size), "lang": lang, "created": now,
        })
        return {"ok": True, "job_id": job_id, "chunk_size": CHUNK_SIZE}

    # ── 2. upload one chunk (retry-safe: same index can be sent again) ──
    @api.put("/upload/{job_id}/{index}")
    async def upload_chunk(job_id: str, index: int, request: Request):
        check(request)
        job = await get_job(job_id)
        if not job or job["status"] != "uploading":
            raise HTTPException(404, "העלאה לא נמצאה")
        total = n_chunks(job["size"])
        if index < 0 or index >= total:
            raise HTTPException(400, "חלק לא תקין")
        expected = CHUNK_SIZE if index < total - 1 else job["size"] - CHUNK_SIZE * (total - 1)
        data = await request.body()
        if len(data) != expected:
            raise HTTPException(400, f"גודל חלק שגוי ({len(data)} במקום {expected})")
        await store.put.aio(k_chunk(job_id, index), data)
        return {"ok": True}

    # ── 3. finish upload → start transcription in the background ──
    @api.post("/upload/{job_id}/done")
    async def upload_done(job_id: str, request: Request):
        check(request)
        job = await get_job(job_id)
        if not job or job["status"] != "uploading":
            raise HTTPException(404, "העלאה לא נמצאה")
        for i in range(n_chunks(job["size"])):
            if not await store.contains.aio(k_chunk(job_id, i)):
                raise HTTPException(400, f"חסר חלק {i} — נסה שוב")
        job["status"] = "queued"
        await put_job(job_id, job)
        audio_url = f"{await public_base(request)}/audio/{job_id}"
        call = await run_job.spawn.aio(job_id, audio_url, job["lang"])
        await store.put.aio(k_call(job_id), call.object_id)
        return {"ok": True, "job_id": job_id, "status": "queued"}

    # ── audio link handed to the Whisper worker (no token: the id is the secret) ──
    @api.get("/audio/{job_id}")
    async def audio(job_id: str):
        job = await get_job(job_id)
        if not job or job["status"] not in ("queued", "transcribing"):
            raise HTTPException(404, "not found")
        total = n_chunks(job["size"])

        async def stream():
            for i in range(total):
                part = await store.get.aio(k_chunk(job_id, i))
                if part is None:
                    raise RuntimeError(f"missing chunk {i}")
                yield part

        return StreamingResponse(
            stream(),
            media_type="application/octet-stream",
            headers={"Content-Length": str(job["size"]), "Cache-Control": "no-store"},
        )

    # ── job status / result (plugin polls this) ──
    @api.get("/job/{job_id}")
    async def job_status(job_id: str, request: Request):
        check(request)
        job = await get_job(job_id)
        if not job:
            raise HTTPException(404, "המשימה לא נמצאה (אולי כבר נמחקה)")
        status = job["status"]
        if status in ("uploading", "queued", "transcribing") and time.time() - job["created"] > JOB_MAX_AGE:
            status = "failed"
            job["status"] = "failed"
            job["error"] = "התמלול לא הסתיים בזמן (timeout)"
            await put_job(job_id, job)
        out = {
            "ok": True,
            "job_id": job_id,
            "status": status,
            "error": job.get("error"),
            "created": job.get("created"),
            "whisper_sec": job.get("whisper_sec"),
        }
        if status == "done":
            out["result"] = await store.get.aio(k_res(job_id))
        return out

    # ── cancel / clean up (plugin calls this after placing captions) ──
    @api.delete("/job/{job_id}")
    async def job_delete(job_id: str, request: Request):
        check(request)
        job = await get_job(job_id)
        if job and job["status"] in ("queued", "transcribing"):
            call_id = await store.get.aio(k_call(job_id))
            if call_id:
                try:
                    await modal.FunctionCall.from_id(call_id).cancel.aio()
                except Exception:  # noqa: BLE001 — best effort
                    pass
        await wipe(job_id, job)
        return {"ok": True}

    return api
