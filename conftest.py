# Presence of this file at the repo root puts the root on sys.path during test
# collection, so `import app` resolves whether tests are run as `pytest …` or
# `python -m pytest …`.
import os

# The per-IP rate limiter would throttle the many register/login calls the suite
# makes from one client (5 registrations/min), causing 429s and flaky failures.
# Disable it for tests; production behavior is unchanged.
os.environ.setdefault("RATELIMIT_DISABLED", "1")
