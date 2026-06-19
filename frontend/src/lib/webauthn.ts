import {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
} from "@simplewebauthn/browser"
import { api, type SecurityStatus } from "@/lib/api"

export const supportsPasskey = browserSupportsWebAuthn

/** Register a new passkey (Windows Hello / Touch ID) for the logged-in user. */
export async function registerPasskey(name = "passkey") {
  const optionsJSON = await api.post("/security/passkey/register/begin")
  // @ts-expect-error options shape comes from the server, fed straight to the lib
  const credential = await startRegistration({ optionsJSON })
  return api.post("/security/passkey/register/finish", { credential, name })
}

/**
 * Ensure a fresh step-up before a sensitive action. Prefers a passkey tap; falls
 * back to prompting for an authenticator/recovery code. Returns true if verified.
 */
export async function ensureStepUp(): Promise<boolean> {
  let status: SecurityStatus
  try {
    status = await api.get<SecurityStatus>("/security/status")
  } catch {
    return false
  }
  if (status.passkeys > 0 && supportsPasskey()) {
    try {
      const optionsJSON = await api.post("/security/passkey/stepup/begin")
      // @ts-expect-error server-provided options
      const credential = await startAuthentication({ optionsJSON })
      await api.post("/security/passkey/stepup/finish", { credential })
      return true
    } catch {
      // fall through to code entry
    }
  }
  if (status.totp_enabled) {
    const code = window.prompt("Enter your authenticator (or recovery) code to confirm:")
    if (!code) return false
    try {
      await api.post("/security/stepup", { code })
      return true
    } catch {
      return false
    }
  }
  return false
}

/** Run a sensitive action; if the server demands step-up (401), verify and retry once. */
export async function withStepUp<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action()
  } catch (e) {
    const status = (e as { status?: number })?.status
    if (status === 401) {
      const ok = await ensureStepUp()
      if (ok) return await action()
    }
    throw e
  }
}
