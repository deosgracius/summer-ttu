"""Content Studio: generate a social campaign (captions + hashtags + Veo 3 video prompt + Canva flyer spec)
via the configured LLM, and hand off to n8n for auto-posting."""
import os
import json


def _provider_model():
    provider = (os.getenv("LLM_PROVIDER") or "anthropic").lower()
    model = os.getenv("LLM_MODEL") or ("claude-haiku-4-5" if provider == "anthropic" else "gpt-5.4-mini")
    if model.startswith("gpt") or model.startswith("o"):
        provider = "openai"
    elif model.startswith("claude"):
        provider = "anthropic"
    return provider, model


async def _llm_text(prompt, system="You are an expert social media marketing strategist."):
    provider, model = _provider_model()
    if provider == "openai":
        from openai import AsyncOpenAI
        c = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))
        r = await c.chat.completions.create(model=model,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": prompt}])
        return r.choices[0].message.content or ""
    from anthropic import AsyncAnthropic
    c = AsyncAnthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
    r = await c.messages.create(model=model, max_tokens=1600, system=system,
                                messages=[{"role": "user", "content": prompt}])
    return r.content[0].text


async def generate_campaign(topic, platforms, context=""):
    plats = ", ".join(platforms) if platforms else "Instagram, TikTok, Facebook, YouTube"
    prompt = (
        f"Create a social media campaign for: {topic}. {context}\n"
        f"Target platforms: {plats}.\n\n"
        "Return ONLY valid JSON (no markdown fences) with exactly this shape:\n"
        '{"captions": {"<platform>": "caption with a hook and clear CTA"}, '
        '"hashtags": ["#tag1", "#tag2"], '
        '"video_prompt": "a vivid 8-second Veo 3 text-to-video prompt", '
        '"flyer": {"headline": "short punchy headline", "subtext": "one supporting line", '
        '"color_theme": "describe colors", "layout": "describe layout"}}\n'
        "Make each caption fit its platform (TikTok punchy, YouTube descriptive, IG visual, FB friendly)."
    )
    try:
        txt = (await _llm_text(prompt)).strip()
    except Exception as e:
        return {"error": f"Couldn't reach the AI model (is your LLM key set on the server?). {e}"}
    if txt.startswith("```"):
        txt = txt.strip("`")
        if txt.lower().startswith("json"):
            txt = txt[4:]
    try:
        return json.loads(txt)
    except Exception:
        return {"raw": txt}


async def send_to_n8n(payload):
    url = os.getenv("N8N_WEBHOOK_URL")
    if not url:
        return {"queued": False, "reason": "N8N_WEBHOOK_URL not set on the server"}
    import httpx
    try:
        async with httpx.AsyncClient(timeout=20) as c:
            r = await c.post(url, json=payload)
        if r.status_code < 300:
            return {"queued": True, "status": r.status_code}
        reason = f"n8n returned HTTP {r.status_code}"
        if r.status_code == 404:
            reason += " — workflow not found. Is it Active, and are you using the Production URL (/webhook/, not /webhook-test/)?"
        elif r.status_code in (401, 403):
            reason += " — authentication rejected. Set the webhook's Authentication to None, or add the matching header."
        return {"queued": False, "status": r.status_code, "reason": reason}
    except Exception as e:
        return {"queued": False, "reason": f"could not reach n8n: {e}"}
