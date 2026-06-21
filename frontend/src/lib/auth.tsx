import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react"
import { api, getToken, setToken, type Me } from "@/lib/api"

interface AuthState {
  me: Me | null
  loading: boolean
  /** Log in with email + password; loads the profile and returns it. */
  login: (email: string, password: string) => Promise<Me>
  /** Adopt an already-issued token (e.g. right after register). */
  adoptToken: (token: string) => Promise<Me>
  refresh: () => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)

  // On first load, if we have a stored token, sync the timezone and fetch the user.
  async function loadMe(): Promise<Me> {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const data = await api.patch<Me>("/auth/me", { timezone: tz })
    setMe(data)
    return data
  }

  useEffect(() => {
    if (!getToken()) {
      setLoading(false)
      return
    }
    loadMe()
      .catch(() => {
        setToken(null)
        setMe(null)
      })
      .finally(() => setLoading(false))
  }, [])

  const value: AuthState = {
    me,
    loading,
    async login(email, password) {
      const token = await api.login(email, password)
      setToken(token)
      // A fresh login should always replay the welcome briefing — clear the
      // once-per-session gate so logging out and back in re-triggers it.
      try { sessionStorage.removeItem("summer_welcomed") } catch { /* ignore */ }
      return loadMe()
    },
    async adoptToken(token) {
      setToken(token)
      try { sessionStorage.removeItem("summer_welcomed") } catch { /* ignore */ }
      return loadMe()
    },
    async refresh() {
      await loadMe()
    },
    logout() {
      setToken(null)
      setMe(null)
      try { sessionStorage.removeItem("summer_welcomed") } catch { /* ignore */ }
    },
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

 
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>")
  return ctx
}
