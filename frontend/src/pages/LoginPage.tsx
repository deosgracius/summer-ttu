import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { startAuthentication } from "@simplewebauthn/browser"
import { useAuth } from "@/lib/auth"
import { api, ApiError, type Profile } from "@/lib/api"
import SummerOrb from "@/components/SummerOrb"
import SplineRobot from "@/components/SplineRobot"
import SpaceBackground from "@/components/SpaceBackground"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card"
import { toast } from "sonner"

type Step = 0 | 1 | 2

export default function LoginPage() {
  const { adoptToken } = useAuth()
  const navigate = useNavigate()

  const [step, setStep] = useState<Step>(0)
  const [busy, setBusy] = useState(false)

  // credentials
  const [email, setEmail] = useState("me@example.com")
  const [password, setPassword] = useState("pw12345")

  // MFA second step
  const [mfa, setMfa] = useState(false)
  const [mfaCode, setMfaCode] = useState("")

  // profile (step 1)
  const [p, setP] = useState<Profile & { city?: string }>({})
  const setField = (k: keyof (Profile & { city?: string })) => (v: string) =>
    setP((prev) => ({ ...prev, [k]: v }))

  async function handleLogin() {
    setBusy(true)
    try {
      const r = await api.loginStart(email, password)
      if (r.access_token) {
        await adoptToken(r.access_token)
        navigate("/")
      } else if (r.mfa_required) {
        setMfa(true) // show the second-factor step
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? "Login failed" : "Could not connect")
    } finally {
      setBusy(false)
    }
  }

  async function completeMfa() {
    setBusy(true)
    try {
      const r = await api.loginMfa(email, password, mfaCode)
      if (r.access_token) {
        await adoptToken(r.access_token)
        navigate("/")
        return
      }
      if (r.passkey_required) {
        // 3rd factor: Windows Hello / Touch ID tap
        const credential = await startAuthentication({
          optionsJSON: r.options as Parameters<typeof startAuthentication>[0]["optionsJSON"],
        })
        const r2 = await api.loginPasskey(email, password, credential)
        if (r2.access_token) {
          await adoptToken(r2.access_token)
          navigate("/")
        }
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Verification failed")
    } finally {
      setBusy(false)
    }
  }

  async function handleRegister() {
    setBusy(true)
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
      const profile: Profile = {
        full_name: p.full_name?.trim(),
        preferred_name: p.preferred_name?.trim(),
        address: p.address?.trim(),
        emergency_name: p.emergency_name?.trim(),
        emergency_email: p.emergency_email?.trim(),
        emergency_phone: p.emergency_phone?.trim(),
        interests: p.interests?.trim(),
      }
      await api.post("/auth/register", {
        email,
        password,
        timezone: tz,
        location: p.city?.trim() || "",
        profile,
      })
      const token = await api.login(email, password)
      await adoptToken(token)
      setStep(2)
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.message : "Registration failed",
      )
    } finally {
      setBusy(false)
    }
  }

  async function forgot() {
    const em = window.prompt("Enter your account email to receive a reset link:")
    if (!em) return
    try {
      const r = await api.post<{ dev_link?: string }>("/auth/forgot", { email: em })
      if (r.dev_link) {
        toast.info("Email isn't configured — using a dev reset link.")
        window.location.href = r.dev_link
      } else {
        toast.success("If that email exists, a reset link was sent.")
      }
    } catch {
      toast.error("Could not send reset link.")
    }
  }

  const connect = (provider: "google" | "spotify" | "outlook") => {
    const token = localStorage.getItem("summer_token") || ""
    window.open(
      `/oauth/${provider}/start?token=${token}`,
      "summer_oauth",
      "width=520,height=700",
    )
  }

  return (
    <div className="summer-bg min-h-svh bg-background text-foreground flex flex-col items-center px-4 py-10">
      <SpaceBackground />
      <SplineRobot />
      {/* Hero */}
      <div className="relative z-10 flex flex-col items-center text-center mb-8">
        <div className="mb-6">
          <SummerOrb size={260} />
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">Hi, I'm Summer.</h1>
        <p className="mt-2 text-muted-foreground max-w-md">
          Your campus AI assistant — find classes and rooms, look up office hours
          and advisors, manage tasks and reminders, and more. Sign in to begin.
        </p>
      </div>

      <Card className="relative z-10 w-full max-w-md">
        {step === 0 && (
          <>
            <CardHeader>
              <CardTitle>Welcome back</CardTitle>
              <CardDescription>Log in or create an account.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="email"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="password"
                  onKeyDown={(e) => e.key === "Enter" && handleLogin()}
                />
              </div>
              <button
                onClick={forgot}
                className="text-sm text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
              >
                Forgot password / username?
              </button>
              {!mfa ? (
                <div className="flex gap-2 pt-2">
                  <Button onClick={() => setStep(1)} disabled={busy}>
                    Register →
                  </Button>
                  <Button variant="secondary" onClick={handleLogin} disabled={busy}>
                    Log in
                  </Button>
                </div>
              ) : (
                <div className="space-y-2 pt-2 border-t">
                  <Label htmlFor="mfacode">Verification</Label>
                  <Input
                    id="mfacode"
                    value={mfaCode}
                    onChange={(e) => setMfaCode(e.target.value)}
                    placeholder="authenticator or recovery code"
                    onKeyDown={(e) => e.key === "Enter" && completeMfa()}
                  />
                  <p className="text-xs text-muted-foreground">
                    Enter your authenticator code. If you also have a passkey, you'll be
                    prompted to confirm with Windows Hello / Touch ID next.
                  </p>
                  <div className="flex gap-2">
                    <Button onClick={completeMfa} disabled={busy}>
                      Continue
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setMfa(false)
                        setMfaCode("")
                      }}
                      disabled={busy}
                    >
                      Back
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </>
        )}

        {step === 1 && (
          <>
            <CardHeader>
              <CardTitle>Tell Summer about you</CardTitle>
              <CardDescription>This personalizes your assistant.</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3">
              <Field label="Full name" onChange={setField("full_name")} />
              <Field
                label="Preferred name"
                placeholder="what to call you"
                onChange={setField("preferred_name")}
              />
              <Field
                label="City"
                placeholder="weather & time"
                onChange={setField("city")}
              />
              <Field label="Address" onChange={setField("address")} />
              <Field label="Emergency contact" onChange={setField("emergency_name")} />
              <Field label="Emergency email" onChange={setField("emergency_email")} />
              <Field label="Emergency phone" onChange={setField("emergency_phone")} />
              <Field
                label="Interests (events)"
                placeholder="music, sports…"
                onChange={setField("interests")}
              />
              <div className="col-span-2 flex gap-2 pt-2">
                <Button onClick={handleRegister} disabled={busy}>
                  Create account →
                </Button>
                <Button variant="ghost" onClick={() => setStep(0)} disabled={busy}>
                  Back
                </Button>
              </div>
            </CardContent>
          </>
        )}

        {step === 2 && (
          <>
            <CardHeader>
              <CardTitle>Connect your accounts</CardTitle>
              <CardDescription>
                Summer works best with these. Each opens in a new tab — connect,
                then come back and continue.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button
                variant="outline"
                className="w-full"
                onClick={() => connect("google")}
              >
                Connect Google (Calendar + Gmail)
              </Button>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => connect("spotify")}
              >
                Connect Spotify
              </Button>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => connect("outlook")}
              >
                Connect Outlook
              </Button>
              <Button className="w-full" onClick={() => navigate("/")}>
                Continue to Summer →
              </Button>
            </CardContent>
          </>
        )}
      </Card>
    </div>
  )
}

function Field({
  label,
  placeholder,
  onChange,
}: {
  label: string
  placeholder?: string
  onChange: (v: string) => void
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}
