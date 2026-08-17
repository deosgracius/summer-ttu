import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { useAuth } from "@/lib/auth"
import { useSpeech } from "@/lib/useSpeech"
import { api, ApiError } from "@/lib/api"
import SummerOrb from "@/components/SummerOrb"
import SplineRobot from "@/components/SplineRobot"
import SpaceBackground from "@/components/SpaceBackground"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"

/**
 * Single-user admin login.
 *
 * There is exactly ONE admin. They sign in with a password — no email, no register.
 * If they forget the password (or on first setup), they type the admin SETUP CODE in the
 * same password box and press Log in: the page then reveals "New password" + "Retype
 * password" to set it, and logs them straight in. The setup code (CENTRAL_ADMIN_PASSWORD)
 * lives only on the server and is never shipped to the browser — the page just tries the
 * password, and only if that fails does it ask the server whether the value was the code.
 *
 * Written for a non-technical operator: one box, plain words, clear errors.
 */
export default function LoginPage() {
  const { adoptToken } = useAuth()
  const { primeAudio } = useSpeech()
  const navigate = useNavigate()

  const [password, setPassword] = useState("")
  const [setMode, setSetMode] = useState(false) // showing the new/retype fields
  const [setupCode, setSetupCode] = useState("") // the value that matched the server's setup code
  const [newPw, setNewPw] = useState("")
  const [retypePw, setRetypePw] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")

  async function handleLogin() {
    // This click is a user gesture — unlock audio now so the dashboard can speak after we navigate.
    primeAudio()
    setErr("")
    setBusy(true)
    try {
      const r = await api.adminLogin(password)
      if (r.access_token) {
        await adoptToken(r.access_token)
        navigate("/")
        return
      }
      setErr("Incorrect password.")
    } catch (e) {
      // The password didn't work. Was it actually the admin setup code? If so, let them set a
      // new password. (This second call is what keeps the code itself off the browser.)
      if (e instanceof ApiError && e.status === 401) {
        const isCode = await api.passcodeOk(password)
        if (isCode) {
          setSetupCode(password)
          setPassword("")
          setSetMode(true)
        } else {
          setErr("Incorrect password.")
        }
      } else {
        setErr("Couldn't reach the server. Check the connection and try again.")
      }
    } finally {
      setBusy(false)
    }
  }

  async function handleSetPassword() {
    setErr("")
    if (newPw.length < 8) {
      setErr("Please use a password of at least 8 characters.")
      return
    }
    if (newPw !== retypePw) {
      setErr("The two passwords don't match.")
      return
    }
    primeAudio()
    setBusy(true)
    try {
      const r = await api.adminSetPassword(setupCode, newPw)
      if (r.access_token) {
        await adoptToken(r.access_token)
        navigate("/")
        return
      }
      setErr("Couldn't set the password. Please try again.")
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Couldn't set the password. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  function backToLogin() {
    setSetMode(false)
    setSetupCode("")
    setNewPw("")
    setRetypePw("")
    setErr("")
  }

  return (
    <div className="summer-bg min-h-svh bg-background text-foreground flex flex-col items-center px-4 py-10">
      <SpaceBackground />
      <SplineRobot />

      <div className="relative z-10 flex flex-col items-center text-center mb-8">
        <div className="mb-6">
          <SummerOrb size={260} />
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">Summer — Admin</h1>
        <p className="mt-2 text-muted-foreground max-w-md">
          Sign in to manage the directory, campus data, and everything the kiosk shows.
        </p>
      </div>

      <Card className="relative z-10 w-full max-w-md">
        {!setMode ? (
          <>
            <CardHeader>
              <CardTitle>Sign in</CardTitle>
              <CardDescription>Enter the admin password.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  autoFocus
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="password"
                  onKeyDown={(e) => e.key === "Enter" && password && !busy && handleLogin()}
                />
              </div>
              {err && <p className="text-sm text-destructive">{err}</p>}
              <Button className="w-full" onClick={handleLogin} disabled={busy || !password}>
                Log in
              </Button>
              <p className="text-xs text-muted-foreground pt-1">
                First time, or forgot the password? Type your admin setup code above and press
                Log in — you'll then choose a new password.
              </p>
            </CardContent>
          </>
        ) : (
          <>
            <CardHeader>
              <CardTitle>Set a new password</CardTitle>
              <CardDescription>Choose the password you'll use to sign in from now on.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="newpw">New password</Label>
                <Input
                  id="newpw"
                  type="password"
                  value={newPw}
                  autoFocus
                  onChange={(e) => setNewPw(e.target.value)}
                  placeholder="at least 8 characters"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="retypepw">Retype password</Label>
                <Input
                  id="retypepw"
                  type="password"
                  value={retypePw}
                  onChange={(e) => setRetypePw(e.target.value)}
                  placeholder="type it again"
                  onKeyDown={(e) => e.key === "Enter" && !busy && handleSetPassword()}
                />
              </div>
              {err && <p className="text-sm text-destructive">{err}</p>}
              <div className="flex gap-2 pt-1">
                <Button onClick={handleSetPassword} disabled={busy || !newPw || !retypePw}>
                  Set password &amp; sign in
                </Button>
                <Button variant="ghost" onClick={backToLogin} disabled={busy}>
                  Back
                </Button>
              </div>
            </CardContent>
          </>
        )}
      </Card>
    </div>
  )
}
