import { useState } from "react"
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
import ApprovalsPanel from "@/components/panels/ApprovalsPanel"
import SecurityPanel from "@/components/panels/SecurityPanel"
import VoiceSettingsPanel from "@/components/panels/VoiceSettingsPanel"
import MyAvailabilityPanel from "@/components/panels/MyAvailabilityPanel"
import WelcomeBriefing from "@/components/WelcomeBriefing"
import SplineRobot from "@/components/SplineRobot"
import SpaceBackground from "@/components/SpaceBackground"

export default function DashboardPage() {
  const { me, logout } = useAuth()
  // Bumping this key tells panels to reload (e.g. after the agent acts).
  const [reloadKey, setReloadKey] = useState(0)
  const refreshAll = () => setReloadKey((k) => k + 1)

  const name =
    me?.profile?.preferred_name || me?.profile?.full_name || me?.email?.split("@")[0]

  return (
    <div className="summer-bg min-h-svh bg-background text-foreground">
      <SpaceBackground />
      <SplineRobot />
      <header className="relative z-10 flex items-center justify-between px-6 py-4 border-b">
        <div className="flex items-center gap-3">
          <div className="summer-orb summer-orb--xs" aria-hidden />
          <div>
            <div className="font-semibold tracking-[0.3em] text-primary">SUMMER</div>
            <div className="text-xs text-muted-foreground">
              {name ? `Welcome back, ${name} · ${me?.role}` : "Personal AI assistant"}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">online</span>
          <Button variant="outline" size="sm" onClick={logout}>
            Log out
          </Button>
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-5xl px-4 sm:px-6 py-8 space-y-6">
        <WelcomeBriefing />

        <AgentChat onChanged={refreshAll} />

        <MyAvailabilityPanel reloadKey={reloadKey} />

        <ApprovalsPanel reloadKey={reloadKey} onApplied={refreshAll} />

        <CampusPanel reloadKey={reloadKey} />

        <PeoplePanel reloadKey={reloadKey} />

        <UserAccessPanel reloadKey={reloadKey} />

        <SecurityPanel reloadKey={reloadKey} />

        <VoiceSettingsPanel reloadKey={reloadKey} />

        <div className="grid gap-6 md:grid-cols-2">
          <TasksPanel reloadKey={reloadKey} />
          <RemindersPanel reloadKey={reloadKey} />
          <DraftsPanel reloadKey={reloadKey} />
          <MemoriesPanel reloadKey={reloadKey} />
        </div>

        <p className="text-center text-xs text-muted-foreground pb-6">
          More coming: events &amp; seat booking, voice mode, vision, settings,
          content studio, admin.
        </p>
      </main>
    </div>
  )
}
