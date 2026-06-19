"""Image understanding via the same LLM key (GPT-4o or Claude — both support vision)."""
import os

VISION_OPENAI = ("gpt-4o", "gpt-4o-mini")


async def analyze_image(image_b64, media_type, question, provider=None):
    provider = (provider or os.getenv("LLM_PROVIDER", "anthropic")).lower()
    q = (question or "").strip() or "Describe this image in detail."
    try:
        if provider == "openai":
            import openai
            key = os.getenv("OPENAI_API_KEY")
            if not key:
                return {"error": "No OPENAI_API_KEY set."}
            model = os.getenv("LLM_MODEL", "gpt-4o-mini")
            if model not in VISION_OPENAI:
                model = "gpt-4o-mini"
            client = openai.AsyncOpenAI(api_key=key)
            resp = await client.chat.completions.create(model=model, max_tokens=700, messages=[{
                "role": "user", "content": [
                    {"type": "text", "text": q},
                    {"type": "image_url", "image_url": {"url": f"data:{media_type};base64,{image_b64}"}}]}])
            return {"answer": resp.choices[0].message.content}
        else:
            import anthropic
            key = os.getenv("ANTHROPIC_API_KEY")
            if not key:
                return {"error": "No ANTHROPIC_API_KEY set."}
            model = os.getenv("LLM_MODEL", "claude-haiku-4-5")
            if not model.startswith("claude"):
                model = "claude-haiku-4-5"
            client = anthropic.AsyncAnthropic(api_key=key)
            resp = await client.messages.create(model=model, max_tokens=700, messages=[{
                "role": "user", "content": [
                    {"type": "text", "text": q},
                    {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": image_b64}}]}])
            return {"answer": "".join(b.text for b in resp.content if b.type == "text")}
    except Exception as e:
        return {"error": f"Vision failed: {e}"}
