import { lazy, Suspense, useState } from "react"
import { MessageSquare, ShieldCheck, Settings as SettingsIcon, Cpu, Users, Database, BarChart3, Activity, ChevronLeft, type LucideIcon } from "lucide-react"
import { ShaderCard, type ShaderConfig } from "@/components/ui/shader-card"
import { useAuth } from "@/lib/auth"
import { Button } from "@/components/ui/button"
import AgentChat from "@/components/AgentChat"
import MemoriesPanel from "@/components/panels/MemoriesPanel"
import CampusPanel from "@/components/panels/CampusPanel"
import PeoplePanel from "@/components/panels/PeoplePanel"
import UserAccessPanel from "@/components/panels/UserAccessPanel"
import DelegationPanel from "@/components/panels/DelegationPanel"
import ApprovalsPanel from "@/components/panels/ApprovalsPanel"
import SecurityPanel from "@/components/panels/SecurityPanel"
import VoiceSettingsPanel from "@/components/panels/VoiceSettingsPanel"
import QuickLinksPanel from "@/components/panels/QuickLinksPanel"
import FileImportPanel from "@/components/panels/FileImportPanel"
import DirectoryPhotosPanel from "@/components/panels/DirectoryPhotosPanel"
import QueryInsightsPanel from "@/components/panels/QueryInsightsPanel"
import FailureLogPanel from "@/components/panels/FailureLogPanel"
import WelcomeBriefing from "@/components/WelcomeBriefing"
import OnboardingModal from "@/components/OnboardingModal"
// Admin-only "Engineering Brain" (3D, three.js) — lazy so it ships only when opened.
// It carries both a System and an Organization layer, so it replaces the old public
// Knowledge Graph tab (which was the same campus directory as its Organization layer).
const EngineeringBrain = lazy(() => import("@/components/EngineeringBrain"))
import SplineRobot from "@/components/SplineRobot"
import SpaceBackground from "@/components/SpaceBackground"

type TabId = "assistant" | "brain" | "admin" | "settings"

// The Admin tab is a console home: a grid of animated shader cards (paper-design/Warp), one per
// area. Clicking a card opens that area's tools. One hue family per area; presets adapted from
// the Warp examples. `central` cards show only to central admins.
type AdminArea = "access" | "directory" | "campus" | "insights" | "health"
const ADMIN_CARDS: { key: AdminArea; icon: LucideIcon; title: string; desc: string; central?: boolean; config: ShaderConfig }[] = [
  {
    key: "access", icon: ShieldCheck, title: "Approvals & access",
    desc: "Approve sign-ups and pending changes, set roles and per-user access, and designate deputy admins.",
    config: { proportion: 0.38, softness: 0.95, distortion: 0.16, swirl: 0.85, swirlIterations: 11, shape: "checks", shapeScale: 0.11, colors: ["hsl(250,100%,30%)", "hsl(270,100%,65%)", "hsl(260,90%,35%)", "hsl(265,100%,70%)"] },
  },
  {
    key: "directory", icon: Users, title: "Directory",
    desc: "The people Summer shows on the kiosk — their profiles and their headshots.",
    config: { proportion: 0.4, softness: 1.2, distortion: 0.2, swirl: 0.9, swirlIterations: 12, shape: "stripes", shapeScale: 0.12, colors: ["hsl(200,100%,25%)", "hsl(180,100%,65%)", "hsl(160,90%,35%)", "hsl(190,100%,75%)"] },
  },
  {
    key: "campus", icon: Database, title: "Campus data",
    desc: "Import a registrar file, then browse and correct the courses, offices, and services Summer answers from.",
    config: { proportion: 0.35, softness: 0.9, distortion: 0.18, swirl: 0.7, swirlIterations: 10, shape: "checks", shapeScale: 0.1, colors: ["hsl(120,100%,25%)", "hsl(140,100%,60%)", "hsl(100,90%,30%)", "hsl(130,100%,70%)"] },
  },
  {
    key: "insights", icon: BarChart3, title: "Insights",
    desc: "What Summer answered instantly from the database vs. with the LLM.",
    config: { proportion: 0.45, softness: 1.1, distortion: 0.22, swirl: 0.8, swirlIterations: 15, shape: "stripes", shapeScale: 0.09, colors: ["hsl(30,100%,35%)", "hsl(50,100%,65%)", "hsl(40,90%,40%)", "hsl(45,100%,75%)"] },
  },
  {
    key: "health", icon: Activity, title: "System health", central: true,
    desc: "Central-admin only: failures Summer has hit, so you can fix what's broken.",
    config: { proportion: 0.42, softness: 1.0, distortion: 0.19, swirl: 0.75, swirlIterations: 9, shape: "stripes", shapeScale: 0.13, colors: ["hsl(330,100%,30%)", "hsl(350,100%,60%)", "hsl(340,90%,35%)", "hsl(345,100%,70%)"] },
  },
]

export default function DashboardPage() {
  const { me, logout } = useAuth()
  // Bumping this key tells panels to reload (e.g. after the agent acts).
  const [reloadKey, setReloadKey] = useState(0)
  const refreshAll = () => setReloadKey((k) => k + 1)
  // First-login welcome + details capture, until the user completes (or skips) it.
  const [onboard, setOnboard] = useState(!me?.profile?.onboarded)
  const [tab, setTab] = useState<TabId>("assistant")
  // Which admin area is open (null = the console home / card grid).
  const [adminView, setAdminView] = useState<AdminArea | null>(null)
  // A question handed to the Assistant tab (e.g. "Ask Summer about X" from the graph).
  const [pendingAsk, setPendingAsk] = useState<string | null>(null)

  const isAdmin = me?.role === "admin" || me?.role === "central_admin"
  const isCentral = me?.role === "central_admin"
  const name =
    me?.profile?.preferred_name || me?.profile?.full_name || me?.email?.split("@")[0]

  // Tabs replace the old long scroll: each section is one click away, and only its
  // panels render — so the most important things are reachable without scrolling.
  const tabs: { id: TabId; label: string; icon: typeof MessageSquare; show: boolean }[] = [
    { id: "assistant", label: "Assistant", icon: MessageSquare, show: true },
    { id: "admin", label: "Admin", icon: ShieldCheck, show: isAdmin },
    { id: "brain", label: "Engineering Brain", icon: Cpu, show: isAdmin },
    { id: "settings", label: "Settings", icon: SettingsIcon, show: true },
  ]

  return (
    <div className="summer-bg min-h-svh bg-background text-foreground">
      <SpaceBackground />
      <SplineRobot />
      {onboard && <OnboardingModal onDone={() => setOnboard(false)} />}

      <header className="sticky top-0 z-20 flex items-center justify-between px-6 py-4 border-b border-border/40 bg-background/70 backdrop-blur-xl">
        <div className="flex items-center gap-3">
          <div className="summer-orb summer-orb--xs" aria-hidden />
          <div>
            <div className="font-semibold tracking-[0.3em] text-primary">SUMMER</div>
            <div className="text-xs text-muted-foreground">
              {name ? (
                <>Welcome back, {name} · <span className="capitalize">{me?.role?.replace("_", " ")}</span></>
              ) : "Campus assistant"}
            </div>
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
          {tabs.filter((t) => t.show).map((t) => {
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
          {tab === "assistant" && (
            <>
              <WelcomeBriefing />
              <AgentChat onChanged={refreshAll} pendingAsk={pendingAsk} onAsked={() => setPendingAsk(null)} />
            </>
          )}

          {tab === "admin" && isAdmin && adminView === null && (
            <div>
              <div className="mb-6">
                <h1 className="text-2xl font-semibold tracking-tight">Admin console</h1>
                <p className="mt-1 text-sm text-muted-foreground">Pick an area to manage — everything Summer answers from lives here.</p>
              </div>
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {ADMIN_CARDS.filter((c) => !c.central || isCentral).map((c) => (
                  <ShaderCard
                    key={c.key}
                    icon={<c.icon className="size-9" strokeWidth={1.75} />}
                    title={c.title}
                    description={c.desc}
                    config={c.config}
                    onClick={() => setAdminView(c.key)}
                  />
                ))}
              </div>
            </div>
          )}

          {tab === "admin" && isAdmin && adminView !== null && (
            <div className="space-y-6">
              <div className="flex items-center gap-3">
                <Button variant="ghost" size="sm" onClick={() => setAdminView(null)} className="gap-1.5 text-muted-foreground">
                  <ChevronLeft className="size-4" /> Admin
                </Button>
                {(() => {
                  const active = ADMIN_CARDS.find((c) => c.key === adminView)
                  if (!active) return null
                  const Icon = active.icon
                  return (
                    <>
                      <span className="grid size-9 place-items-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
                        <Icon className="size-[18px]" />
                      </span>
                      <h2 className="text-lg font-semibold tracking-tight">{active.title}</h2>
                    </>
                  )
                })()}
              </div>

              {adminView === "access" && (
                <div className="space-y-4">
                  <ApprovalsPanel reloadKey={reloadKey} onApplied={refreshAll} />
                  <UserAccessPanel reloadKey={reloadKey} />
                  <DelegationPanel />
                </div>
              )}
              {adminView === "directory" && (
                <div className="space-y-4">
                  <PeoplePanel reloadKey={reloadKey} />
                  <DirectoryPhotosPanel />
                </div>
              )}
              {adminView === "campus" && (
                <div className="space-y-4">
                  <FileImportPanel />
                  <CampusPanel reloadKey={reloadKey} />
                  <QuickLinksPanel />
                </div>
              )}
              {adminView === "insights" && <QueryInsightsPanel />}
              {adminView === "health" && isCentral && <FailureLogPanel />}
            </div>
          )}

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
