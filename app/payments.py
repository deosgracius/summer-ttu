"""Stripe payments (test mode). All gated behind STRIPE_SECRET_KEY; degrades gracefully when unset."""
import os


def enabled():
    return bool(os.getenv("STRIPE_SECRET_KEY"))


def publishable():
    return os.getenv("STRIPE_PUBLISHABLE_KEY", "")


def create_intent(amount, metadata=None):
    if not enabled():
        return {"enabled": False}
    try:
        import stripe
        stripe.api_key = os.getenv("STRIPE_SECRET_KEY")
        pi = stripe.PaymentIntent.create(
            amount=int(round(amount * 100)), currency="usd",
            payment_method_types=["card"], metadata=metadata or {})
        return {"enabled": True, "client_secret": pi.client_secret, "id": pi.id}
    except Exception as e:
        return {"enabled": True, "error": f"Stripe error: {e}"}
