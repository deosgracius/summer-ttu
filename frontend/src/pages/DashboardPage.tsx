import { lazy, Suspense, useState } from "react"
import { Cpu, Settings as SettingsIcon, Users, Database, BarChart3, Activity, type LucideIcon } from "lucide-react"
import { useAuth } from "@/lib/auth"
import { Button } from "@/components/ui/button"
import MemoriesPanel from "@/components/panels/MemoriesPanel"
import CampusPanel from "@/components/panels/CampusPanel"
import PeoplePanel from "@/components/panels/PeoplePanel"
import SecurityPanel from "@/components/panels/SecurityPanel"
import VoiceSettingsPanel from "@/components/panels/VoiceSettingsPanel"
import QuickLinksPanel from "@/components/panels/QuickLinksPanel"
import FileImportPanel from "@/components/panels/FileImportPanel"
import DirectoryPhotosPanel from "@/components/panels/DirectoryPhotosPanel"
import OfficeHoursPanel from "@/components/panels/OfficeHoursPanel"
import QueryInsightsPanel from "@/components/panels/QueryInsightsPanel"
import FailureLogPanel from "@/components/panels/FailureLogPanel"
// Admin-only "Engineering Brain" (3D, three.js) — lazy so it ships only when opened.
const EngineeringBrain = lazy(() => import("@/components/EngineeringBrain"))
import SplineRobot from "@/components/SplineRobot"
import SpaceBackground from "@/components/SpaceBackground"

// Single-user admin: six top-level sections, no roles, no console card-grid, no welcome box.
// Everything the kiosk shows is managed from here.
type TabId = "directory" | "campus" | "insights" | "health" | "brain" | "settings"

export default function DashboardPage() {
  const { logout } = useAuth()
  const [reloadKey] = useState(0)
  const [tab, setTab] = useState<TabId>("directory")

  const tabs: { id: TabId; label: string; icon: LucideIcon }[] = [
    { id: "directory", label: "Directory", icon: Users },
    { id: "campus", label: "Campus Data", icon: Database },
    { id: "insights", label: "Insights", icon: BarChart3 },
    { id: "health", label: "System Health", icon: Activity },
    { id: "brain", label: "Engineering Brain", icon: Cpu },
    { id: "settings", label: "Settings", icon: SettingsIcon },
  ]

  return (
    <div className="summer-bg min-h-svh bg-background text-foreground">
      <SpaceBackground />
      <SplineRobot />

      <header className="sticky top-0 z-20 flex items-center justify-between px-6 py-4 border-b border-border/40 bg-background/70 backdrop-blur-xl">
        <div className="flex items-center gap-3">
          <div className="summer-orb summer-orb--xs" aria-hidden />
          <div>
            <div className="font-semibold tracking-[0.3em] text-primary">SUMMER</div>
            <div className="text-xs text-muted-foreground">Admin</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="inline-block size-2 rounded-full bg-emerald-400" /> online
          </span>
          <Button variant="outline" size="sm" onClick={logout}>
            Log out
          </Button>
        </div>
      </header>

      {/* Section navigation — sticky, so switching sections never requires scrolling. */}
      <nav className="sticky top-[68px] z-10 border-b border-border/40 bg-background/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-4 sm:px-6 py-2">
          {tabs.map((t) => {
            const Icon = t.icon
            const active = tab === t.id
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                aria-current={active ? "page" : undefined}
                className={`inline-flex shrink-0 items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors ${
                  active
                    ? "bg-primary/15 text-foreground"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                }`}
              >
                <Icon className="size-4" /> {t.label}
              </button>
            )
          })}
        </div>
      </nav>

      {tab === "brain" ? (
        // Full-bleed: the brain uses the entire area below the header/nav, edge to edge.
        <div className="relative z-10">
          <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">Loading the brain…</p>}>
            <EngineeringBrain />
          </Suspense>
        </div>
      ) : (
        <main className="relative z-10 mx-auto w-full max-w-5xl px-4 sm:px-6 py-8 space-y-6">
          {tab === "directory" && (
            <div className="space-y-4">
              <PeoplePanel reloadKey={reloadKey} />
              <OfficeHoursPanel />
              <DirectoryPhotosPanel />
            </div>
          )}

          {tab === "campus" && (
            <div className="space-y-4">
              <FileImportPanel />
              <CampusPanel reloadKey={reloadKey} />
              <QuickLinksPanel />
            </div>
          )}

          {tab === "insights" && <QueryInsightsPanel />}

          {tab === "health" && <FailureLogPanel />}

          {tab === "settings" && (
            <>
              <SecurityPanel reloadKey={reloadKey} />
              <VoiceSettingsPanel reloadKey={reloadKey} />
              <MemoriesPanel reloadKey={reloadKey} />
            </>
          )}

          <p className="text-center text-xs text-muted-foreground pb-6">
            Summer — TTU ECE campus assistant.
          </p>
        </main>
      )}
    </div>
  )
}
