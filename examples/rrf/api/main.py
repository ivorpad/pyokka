"""A small FastAPI service over the RRF demo, for debugging a server with Pyokka.

Needs fastapi and uvicorn. Run it under the debugger from examples/rrf:

    pyokka debug --module api.main --cwd . --stop-on-entry
    pyokka break --live api/main.py:52            # first statement of the /rank handler
    pyokka continue --live --no-wait
    curl -s localhost:8765/rank -H 'content-type: application/json' \
         -d '{"rankings": {"bm25": ["A", "C", "B", "D"], "vector": ["C", "E", "A", "B"]}}'

The request pauses in `rank` on its worker thread. `step --live --into` at the `rrf(...)` line
lands in api/ranking.py in both modes; at the `JSONResponse(...)` line it lands inside Starlette
only when the launch has `libraryCode: true` (.vscode/launch.json has both), otherwise on the
next line here. `GET /documents/zzz` raises `HTTPException`, which Starlette catches, so it
pauses only after `break --live --on-exception raised`.
"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

try:  # `python -m api.main`, and the launch configurations
    from .ranking import fused_order, rrf
except ImportError:  # `pyokka debug api/main.py`, where this file runs as a script
    from ranking import fused_order, rrf

DOCUMENTS = {
    "A": "Button component with primary and secondary variants",
    "B": "Form input component with validation",
    "C": "Primary button used for important actions",
    "D": "Navigation menu and sidebar",
    "E": "CTA component for submitting forms",
}

app = FastAPI(title="RRF demo API")


class RankRequest(BaseModel):
    rankings: dict[str, list[str]] = Field(..., min_length=1)
    k: int = Field(60, ge=1)


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.post("/rank")
def rank(request: RankRequest) -> JSONResponse:
    scores = rrf(request.rankings, request.k)
    ordered = fused_order(scores)
    items = []
    for position, (document_id, score) in enumerate(ordered, start=1):
        items.append({"position": position, "id": document_id, "score": round(score, 6), "text": DOCUMENTS.get(document_id)})
    payload = {"k": request.k, "items": items}
    response = JSONResponse(content=payload)
    return response


@app.get("/documents/{document_id}")
def document(document_id: str) -> dict[str, str]:
    text = DOCUMENTS.get(document_id)
    if text is None:
        raise HTTPException(status_code=404, detail=f"no document {document_id!r}")
    return {"id": document_id, "text": text}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="warning")
