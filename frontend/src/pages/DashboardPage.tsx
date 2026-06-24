import { useState } from "react"
import { MessageSquare, GraduationCap, ListChecks, ShieldCheck, Settings as SettingsIcon } from "lucide-react"
import { useAuth } from "@/lib/auth"
import { Button } from "@/components/ui/button"
import AgentChat from "@/components/AgentChat"
import TasksPanel from "@/components/panels/TasksPanel"
import RemindersPanel from "@/components/panels/RemindersPanel"
import MemoriesPanel from "@/components/panels/MemoriesPanel"
import DraftsPanel from "@/components/panels/DraftsPanel"
import CampusPanel from "@/components/panels/CampusPanel"
import PeoplePanel from "@/components/panels/PeoplePanel"
import UserAccessPanel from "@/components/panels/UserAccessPanel"
import DelegationPanel from "@/components/panels/DelegationPanel"
import ApprovalsPanel from "@/components/panels/ApprovalsPanel"
import SecurityPanel from "@/components/panels/SecurityPanel"
import VoiceSettingsPanel from "@/components/panels/VoiceSettingsPanel"
import ConnectionsPanel from "@/components/panels/ConnectionsPanel"
import QuickLinksPanel from "@/components/panels/QuickLinksPanel"
import FileImportPanel from "@/components/panels/FileImportPanel"
import MyAvailabilityPanel from "@/components/panels/MyAvailabilityPanel"
import WelcomeBriefing from "@/components/WelcomeBriefing"
import OnboardingModal from "@/components/OnboardingModal"
import SplineRobot from "@/components/SplineRobot"
import SpaceBackground from "@/components/SpaceBackground"

type TabId = "assistant" | "campus" | "items" | "admin" | "settings"

export default function DashboardPage() {
  const { me, logout } = useAuth()
  // Bumping this key tells panels to reload (e.g. after the agent acts).
  const [reloadKey, setReloadKey] = useState(0)
  const refreshAll = () => setReloadKey((k) => k + 1)
  // First-login welcome + details capture, until the user completes (or skips) it.
  const [onboard, setOnboard] = useState(!me?.profile?.onboarded)
  const [tab, setTab] = useState<TabId>("assistant")

  const isAdmin = me?.role === "admin" || me?.role === "central_admin"
  const name =
    me?.profile?.preferred_name || me?.profile?.full_name || me?.email?.split("@")[0]

  // Tabs replace the old long scroll: each section is one click away, and only its
  // panels render — so the most important things are reachable without scrolling.
  const tabs: { id: TabId; label: string; icon: typeof MessageSquare; show: boolean }[] = [
    { id: "assistant", label: "Assistant", icon: MessageSquare, show: true },
    { id: "campus", label: "Campus", icon: GraduationCap, show: true },
    { id: "items", label: "My Items", icon: ListChecks, show: true },
    { id: "admin", label: "Admin", icon: ShieldCheck, show: isAdmin },
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

      <main className="relative z-10 mx-auto max-w-5xl px-4 sm:px-6 py-8 space-y-6">
        {tab === "assistant" && (
          <>
            <WelcomeBriefing />
            <AgentChat onChanged={refreshAll} />
          </>
        )}

        {tab === "campus" && (
          <>
            <CampusPanel reloadKey={reloadKey} />
            <PeoplePanel reloadKey={reloadKey} />
            <QuickLinksPanel />
          </>
        )}

        {tab === "items" && (
          <>
            <MyAvailabilityPanel reloadKey={reloadKey} />
            <div className="grid gap-6 md:grid-cols-2">
              <TasksPanel reloadKey={reloadKey} />
              <RemindersPanel reloadKey={reloadKey} />
              <DraftsPanel reloadKey={reloadKey} />
              <MemoriesPanel reloadKey={reloadKey} />
            </div>
          </>
        )}

        {tab === "admin" && isAdmin && (
          <>
            <ApprovalsPanel reloadKey={reloadKey} onApplied={refreshAll} />
            <UserAccessPanel reloadKey={reloadKey} />
            <DelegationPanel />
            <FileImportPanel />
          </>
        )}

        {tab === "settings" && (
          <>
            <SecurityPanel reloadKey={reloadKey} />
            <VoiceSettingsPanel reloadKey={reloadKey} />
            <ConnectionsPanel reloadKey={reloadKey} />
          </>
        )}

        <p className="text-center text-xs text-muted-foreground pb-6">
          Summer — TTU ECE campus assistant.
        </p>
      </main>
    </div>
  )
}
