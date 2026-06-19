import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom"
import { AuthProvider, useAuth } from "@/lib/auth"
import { Toaster } from "@/components/ui/sonner"
import LoginPage from "@/pages/LoginPage"
import DashboardPage from "@/pages/DashboardPage"
import KioskPage from "@/pages/KioskPage"

function Protected({ children }: { children: React.ReactNode }) {
  const { me, loading } = useAuth()
  if (loading) {
    return (
      <div className="min-h-svh grid place-items-center bg-background text-muted-foreground">
        Loading…
      </div>
    )
  }
  return me ? <>{children}</> : <Navigate to="/login" replace />
}

function Routed() {
  const { me } = useAuth()
  return (
    <Routes>
      <Route
        path="/login"
        element={me ? <Navigate to="/" replace /> : <LoginPage />}
      />
      <Route
        path="/"
        element={
          <Protected>
            <DashboardPage />
          </Protected>
        }
      />
      {/* Public hallway kiosk — no login required */}
      <Route path="/kiosk" element={<KioskPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        {/* Force dark theme — SUMMER's look is a dark space console. */}
        <div className="dark">
          <Routed />
          <Toaster />
        </div>
      </AuthProvider>
    </BrowserRouter>
  )
}
