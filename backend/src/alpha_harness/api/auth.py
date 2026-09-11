"""Sign-in, session state, and cached platform metadata."""

from __future__ import annotations

import contextlib
from typing import Any

from fastapi import APIRouter, Query, Response  # <-- 1. ADD Response
from pydantic import BaseModel, Field

from ..brain.settings_schema import resolve_options, validate_settings
from ..realtime import TOPIC_SESSION
from .deps import State

router = APIRouter(prefix="/api/auth", tags=["auth"])

class LoginRequest(BaseModel):
    email: str | None = Field(default=None, description="Leave empty to use the saved login")
    password: str | None = Field(default=None, repr=False)

@router.get("/status")
async def status(state: State, refresh: bool = Query(False)) -> dict[str, Any]:
    info = await state.auth.status(refresh=refresh)
    return {**info.to_dict(), "storedEmail": await state.auth.stored_email()}

@router.post("/login")
async def login(payload: LoginRequest, state: State, response: Response) -> dict[str, Any]:  # <-- 2. ADD response
    info = await state.auth.login(payload.email, payload.password)

    if info.authenticated:
        # 3. ADD THIS BLOCK - tells browser to stay logged in
        response.set_cookie(
            key="ah_auth",
            value="1",
            httponly=True,
            secure=True,      # required for https
            samesite="none",  # required for vercel -> render
            path="/",
            max_age=7*24*60*60
        )
        
        state.engine.configure_from_permissions(info.permissions)
        with contextlib.suppress(Exception):
            await state.auth.refresh_metadata()

    await state.hub.broadcast(TOPIC_SESSION, info.to_dict())
    return info.to_dict()

@router.post("/logout")
async def logout(state: State, response: Response) -> dict[str, Any]:  # <-- 4. ADD response
    await state.auth.logout()
    response.delete_cookie(key="ah_auth", path="/", secure=True, samesite="none") # <-- 5. CLEAR cookie
    
    info = state.auth.session
    await state.hub.broadcast(TOPIC_SESSION, info.to_dict())
    return info.to_dict()

@router.delete("/credential")
async def forget_credential(state: State) -> dict[str, bool]:
    await state.auth.forget()
    await state.hub.broadcast(TOPIC_SESSION, state.auth.session.to_dict())
    return {"ok": True}

@router.get("/settings-schema")
async def settings_schema(state: State, refresh: bool = Query(False)) -> dict[str, Any]:
    if refresh:
        return {"cached": False, "schema": await state.auth.refresh_metadata()}
    cached = await state.auth.cached_settings_schema()
    if cached is None:
        return {"cached": False, "schema": await state.auth.refresh_metadata()}
    return {"cached": True, "schema": cached}

class ResolveOptionsRequest(BaseModel):
    settings: dict[str, Any] = Field(default_factory=dict)

@router.post("/settings-options")
async def settings_options(payload: ResolveOptionsRequest, state: State) -> dict[str, Any]:
    schema = await state.auth.cached_settings_schema()
    if schema is None:
        schema = await state.auth.refresh_metadata()
    return {
        "fields": resolve_options(schema, payload.settings),
        "problems": validate_settings(schema, payload.settings),
        "missing": validate_settings(schema, payload.settings, require_all=True),
    }

@router.get("/operators")
async def operators(state: State, refresh: bool = Query(False)) -> dict[str, Any]:
    if not refresh:
        cached = await state.auth.cached_operators()
        if cached is not None:
            return {"cached": True, "count": len(cached), "operators": cached}
    fresh = await state.auth.refresh_operators()
    return {"cached": False, "count": len(fresh), "operators": fresh}
