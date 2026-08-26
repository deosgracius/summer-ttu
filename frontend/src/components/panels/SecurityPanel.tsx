import { useEffect, useState } from "react"
import QRCode from "qrcode"
import { api, ApiError, type SecurityStatus } from "@/lib/api"
import { registerPasskey, supportsPasskey } from "@/lib/webauthn"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { PanelCard } from "@/components/panels/PanelCard"
import { toast } from "sonner"

export default function SecurityPanel({ reloadKey }: { reloadKey?: number }) {
  const [status, setStatus] = useState<SecurityStatus | null>(null)
  const [setup, setSetup] = useState<{ secret: string; otpauth_uri: string } | null>(null)
  const [qr, setQr] = useState<string>("")
  const [code, setCode] = useState("")
  const [recovery, setRecovery] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)

  async function loadStatus() {
    try {
      setStatus(await api.get<SecurityStatus>("/security/status"))
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    loadStatus()
  }, [reloadKey])

  useEffect(() => {
    if (setup?.otpauth_uri) QRCode.toDataURL(setup.otpauth_uri).then(setQr).catch(() => setQr(""))
    else setQr("")
  }, [setup])

  async function beginTotp() {
    setBusy(true)
    try {
      setRecovery(null)
      setSetup(await api.post<{ secret: string; otpauth_uri: string }>("/security/totp/setup"))
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "We couldn't start setup. Please try again in a minute.")
    } finally {
      setBusy(false)
    }
  }

  async function verifyTotp() {
    setBusy(true)
    try {
      const res = await api.post<{ recovery_codes: string[] }>("/security/totp/verify", { code })
      setRecovery(res.recovery_codes)
      setSetup(null)
      setCode("")
      toast.success("Authenticator enabled")
      loadStatus()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "That code didn't match. Check your authenticator app and enter the current 6-digit code.")
    } finally {
      setBusy(false)
    }
  }

  // Turning the authenticator off asks for a code in the app's own styled section below —
  // not window.prompt, whose bare grey box looked broken next to the rest of the dashboard.
  const [disabling, setDisabling] = useState(false)
  const [disableCode, setDisableCode] = useState("")

  async function disableTotp() {
    const c = disableCode.trim()
    if (!c) return
    setBusy(true)
    try {
      await api.post("/security/totp/disable", { code: c })
      toast.success("Extra sign-in security is now off")
      setDisabling(false)
      setDisableCode("")
      loadStatus()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "We couldn't turn it off. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  async function addPasskey() {
    setBusy(true)
    try {
      await registerPasskey()
      toast.success("Passkey added")
      loadStatus()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "We couldn't add this sign-in. Make sure Windows Hello or your fingerprint is set up on this computer, then try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <PanelCard title="Extra sign-in security">
      {status && (
        <div className="text-xs text-muted-foreground">
          Authenticator app: <b className={status.totp_enabled ? "text-emerald-400" : ""}>
            {status.totp_enabled ? "On" : "Off"}</b>
          {" · "}Sign-in keys saved: <b>{status.passkeys}</b>
          {status.totp_enabled && <> · Backup codes left: <b>{status.recovery_remaining}</b></>}
        </div>
      )}

      {/* Authenticator setup */}
      {!status?.totp_enabled && !setup && (
        <Button className="mt-3" size="sm" onClick={beginTotp} disabled={busy}>
          Set up authenticator app
        </Button>
      )}

      {setup && (
        <div className="mt-3 space-y-2">
          <div className="text-xs text-muted-foreground">
            Scan this in Google Authenticator / Authy, then enter the 6-digit code.
          </div>
          {qr && <img src={qr} alt="Authenticator QR" className="size-40 rounded bg-white p-2" />}
          <div className="text-xs">
            Can't scan the square? Type this setup key into your authenticator app instead: <code className="text-foreground">{setup.secret}</code>
          </div>
          <div className="flex gap-2">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="6-digit code"
              onKeyDown={(e) => e.key === "Enter" && verifyTotp()}
            />
            <Button size="sm" onClick={verifyTotp} disabled={busy}>
              Verify
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSetup(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Recovery codes (shown once) */}
      {recovery && (
        <div className="mt-3 rounded-md border border-amber-500/40 p-3">
          <div className="text-xs text-amber-400 mb-1">
            Save these recovery codes now — each works once, and they won't be shown again.
          </div>
          <div className="grid grid-cols-2 gap-1 font-mono text-xs">
            {recovery.map((c) => (
              <div key={c}>{c}</div>
            ))}
          </div>
        </div>
      )}

      {/* Passkey */}
      <div className="mt-4 flex flex-wrap gap-2">
        {supportsPasskey() && (
          <Button size="sm" variant="secondary" onClick={addPasskey} disabled={busy}>
            Add fingerprint / face sign-in (Windows Hello / Touch ID)
          </Button>
        )}
        {status?.totp_enabled && !disabling && (
          <Button size="sm" variant="ghost" onClick={() => setDisabling(true)}>
            Turn off authenticator
          </Button>
        )}
      </div>

      {/* Turn-off flow: the app's own styled section, matching the setup flow above. */}
      {disabling && (
        <div className="mt-3 space-y-2 rounded-md border p-3">
          <div className="text-xs text-muted-foreground">
            To turn off extra sign-in security, enter the 6-digit code from your authenticator
            app (or one of your backup codes).
          </div>
          <div className="flex gap-2">
            <Input
              value={disableCode}
              onChange={(e) => setDisableCode(e.target.value)}
              placeholder="6-digit code or backup code"
              onKeyDown={(e) => e.key === "Enter" && disableTotp()}
              autoFocus
            />
            <Button size="sm" onClick={disableTotp} disabled={busy || !disableCode.trim()}>
              Turn it off
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setDisabling(false); setDisableCode("") }} disabled={busy}>
              Keep it on
            </Button>
          </div>
        </div>
      )}
    </PanelCard>
  )
}
