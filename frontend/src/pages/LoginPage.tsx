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

type Step = 0 | 1 | 2 | 3

export default function LoginPage() {
  const { adoptToken } = useAuth()
  const navigate = useNavigate()

  const [step, setStep] = useState<Step>(0)
  const [busy, setBusy] = useState(false)

  // credentials
  const [email, setEmail] = useState("me@example.com")
  const [password, setPassword] = useState("pw12345")

  // central-admin self-service (passcode-gated register / reset)
  const [cMode, setCMode] = useState<"passcode" | "choose" | "register" | "reset" | "link">("passcode")
  const [passcode, setPasscode] = useState("")
  const [cEmail, setCEmail] = useState("")
  const [cPassword, setCPassword] = useState("")
  const [cCity, setCCity] = useState("Lubbock, TX")
  const [resetLink, setResetLink] = useState("")

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

  // ---- Central-admin self-service. The passcode (CENTRAL_ADMIN_PASSWORD) is used
  // ONLY here, to register the central admin the first time or to get a reset link.
  // It is never a login credential; after this they sign in with email + password. ----
  async function centralStart() {
    setBusy(true)
    try {
      const r = await api.post<{ ok: boolean; has_account: boolean }>(
        "/auth/central/start", { passcode })
      setCMode(r.has_account ? "reset" : "register")
    } catch (e) {
      toast.error(e instanceof ApiError ? "Incorrect passcode" : "Could not connect")
    } finally {
      setBusy(false)
    }
  }

  async function centralRegister() {
    setBusy(true)
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
      const r = await api.post<{ access_token?: string }>("/auth/central/register", {
        passcode, email: cEmail.trim(), password: cPassword,
        location: cCity.trim(), timezone: tz,
      })
      if (r.access_token) {
        await adoptToken(r.access_token)
        setStep(2) // go connect Google / Outlook / Spotify
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Registration failed")
    } finally {
      setBusy(false)
    }
  }

  async function centralResetLink() {
    setBusy(true)
    try {
      const r = await api.post<{ reset_link: string }>("/auth/central/reset-link", {
        passcode, email: cEmail.trim(),
      })
      setResetLink(r.reset_link)
      setCMode("link")
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not create reset link")
    } finally {
      setBusy(false)
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
              <div className="flex flex-col gap-1">
                <button
                  onClick={forgot}
                  className="text-left text-sm text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
                >
                  Forgot password / username?
                </button>
                <button
                  onClick={() => { setStep(3); setCMode("passcode") }}
                  className="text-left text-sm text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
                >
                  Central admin setup or password reset
                </button>
              </div>
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

        {step === 3 && (
          <>
            <CardHeader>
              <CardTitle>Central admin</CardTitle>
              <CardDescription>
                {cMode === "passcode"
                  ? "Enter the one-time central passcode. It's used only to set up or reset your access — not to log in."
                  : cMode === "choose"
                  ? "Do you already have an account?"
                  : cMode === "register"
                  ? "No account yet — register the central administrator."
                  : cMode === "reset"
                  ? "Reset the password for your central account."
                  : "Your one-time reset link is ready."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {cMode === "passcode" && (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="passcode">Central passcode</Label>
                    <Input
                      id="passcode"
                      type="password"
                      value={passcode}
                      onChange={(e) => setPasscode(e.target.value)}
                      placeholder="one-time passcode"
                      onKeyDown={(e) => e.key === "Enter" && passcode && centralStart()}
                    />
                  </div>
                  <div className="flex gap-2 pt-1">
                    <Button onClick={centralStart} disabled={busy || !passcode}>
                      Continue →
                    </Button>
                    <Button variant="ghost" onClick={() => setStep(0)} disabled={busy}>
                      Back
                    </Button>
                  </div>
                </>
              )}

              {(cMode === "register" || cMode === "reset") && (
                <div className="flex gap-2 text-sm">
                  <button
                    onClick={() => setCMode("register")}
                    className={`underline-offset-4 hover:underline ${cMode === "register" ? "text-foreground font-medium" : "text-muted-foreground"}`}
                  >
                    I'm registering
                  </button>
                  <span className="text-muted-foreground">·</span>
                  <button
                    onClick={() => setCMode("reset")}
                    className={`underline-offset-4 hover:underline ${cMode === "reset" ? "text-foreground font-medium" : "text-muted-foreground"}`}
                  >
                    I forgot my password
                  </button>
                </div>
              )}

              {cMode === "register" && (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="cemail">Your email</Label>
                    <Input id="cemail" value={cEmail} onChange={(e) => setCEmail(e.target.value)}
                           placeholder="you@ttu.edu" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="cpw">Choose a password</Label>
                    <Input id="cpw" type="password" value={cPassword}
                           onChange={(e) => setCPassword(e.target.value)}
                           placeholder="at least 8 characters" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="ccity">City (weather & time)</Label>
                    <Input id="ccity" value={cCity} onChange={(e) => setCCity(e.target.value)} />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    After this you'll connect Google Calendar, Outlook, and Spotify.
                  </p>
                  <div className="flex gap-2 pt-1">
                    <Button onClick={centralRegister}
                            disabled={busy || !cEmail.trim() || cPassword.length < 8}>
                      Create account →
                    </Button>
                    <Button variant="ghost" onClick={() => setStep(0)} disabled={busy}>Back</Button>
                  </div>
                </>
              )}

              {cMode === "reset" && (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="cremail">Your account email</Label>
                    <Input id="cremail" value={cEmail} onChange={(e) => setCEmail(e.target.value)}
                           placeholder="you@ttu.edu"
                           onKeyDown={(e) => e.key === "Enter" && cEmail.trim() && centralResetLink()} />
                  </div>
                  <div className="flex gap-2 pt-1">
                    <Button onClick={centralResetLink} disabled={busy || !cEmail.trim()}>
                      Get reset link →
                    </Button>
                    <Button variant="ghost" onClick={() => setStep(0)} disabled={busy}>Back</Button>
                  </div>
                </>
              )}

              {cMode === "link" && (
                <>
                  <p className="text-sm text-muted-foreground">
                    Open this single-use link (valid 30 minutes) to set a new password,
                    then sign in normally.
                  </p>
                  <Button className="w-full" onClick={() => { window.location.href = resetLink }}>
                    Open password reset page →
                  </Button>
                  <Input readOnly value={resetLink} onFocus={(e) => e.currentTarget.select()}
                         className="text-xs" />
                  <Button variant="ghost" onClick={() => setStep(0)}>Back to login</Button>
                </>
              )}
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
