import { useEffect, useState } from "react"
import QRCode from "qrcode"
import { api, type SecurityStatus } from "@/lib/api"
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
      toast.error(e instanceof Error ? e.message : "Could not start setup")
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
      toast.error(e instanceof Error ? e.message : "Verification failed")
    } finally {
      setBusy(false)
    }
  }

  async function disableTotp() {
    const c = window.prompt("Enter a current authenticator or recovery code to turn off MFA:")
    if (!c) return
    try {
      await api.post("/security/totp/disable", { code: c })
      toast.success("Authenticator disabled")
      loadStatus()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not disable")
    }
  }

  async function addPasskey() {
    setBusy(true)
    try {
      await registerPasskey()
      toast.success("Passkey added")
      loadStatus()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Passkey registration failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <PanelCard title="Security (MFA)">
      {status && (
        <div className="text-xs text-muted-foreground">
          Authenticator: <b className={status.totp_enabled ? "text-emerald-400" : ""}>
            {status.totp_enabled ? "on" : "off"}</b>
          {" · "}Passkeys: <b>{status.passkeys}</b>
          {status.totp_enabled && <> · Recovery codes left: <b>{status.recovery_remaining}</b></>}
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
            Can't scan? Key: <code className="text-foreground">{setup.secret}</code>
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
            Add passkey (Windows Hello / Touch ID)
          </Button>
        )}
        {status?.totp_enabled && (
          <Button size="sm" variant="ghost" onClick={disableTotp}>
            Turn off authenticator
          </Button>
        )}
      </div>
    </PanelCard>
  )
}
