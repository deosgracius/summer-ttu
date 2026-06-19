import { useEffect, useState } from "react"
import { api } from "@/lib/api"
import { useAuth } from "@/lib/auth"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { PanelCard } from "@/components/panels/PanelCard"
import { toast } from "sonner"

const FIELDS: { key: string; label: string }[] = [
  { key: "name", label: "Your name" },
  { key: "role_label", label: "Role (e.g. Tutor, IEEE President)" },
  { key: "subjects", label: "Subjects / focus" },
  { key: "location", label: "Location (building + room)" },
  { key: "schedule", label: "When you're available" },
  { key: "notes", label: "Notes" },
  { key: "semester", label: "Semester" },
]

/** Self-service availability for tutors and student officers. Submissions go to
 * the central admin for approval before they appear on the kiosk. */
export default function MyAvailabilityPanel({ reloadKey }: { reloadKey?: number }) {
  const { me } = useAuth()
  const canUse = me?.role === "tutor" || me?.role === "officer"
  const [form, setForm] = useState<Record<string, string>>({})
  const [hasRecord, setHasRecord] = useState(false)

  async function load() {
    try {
      const rec = await api.get<Record<string, string> | null>("/campus/my-availability")
      if (rec) {
        setHasRecord(true)
        setForm(Object.fromEntries(FIELDS.map((f) => [f.key, String(rec[f.key] ?? "")])))
      }
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    if (canUse) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey, canUse])

  if (!canUse) return null

  async function submit() {
    if (!form.name?.trim()) {
      toast.error("Add your name first")
      return
    }
    try {
      await api.post("/campus/my-availability", form)
      toast.success("Submitted for approval")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Submit failed")
    }
  }

  return (
    <PanelCard title="My Availability">
      <div className="text-xs text-muted-foreground">
        {hasRecord
          ? "Update your details below. Changes go to the central admin for approval before students see them on the kiosk."
          : "Add your tutoring/office availability. It's published to the kiosk once the central admin approves it."}
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <Input
            key={f.key}
            value={form[f.key] ?? ""}
            onChange={(e) => setForm((d) => ({ ...d, [f.key]: e.target.value }))}
            placeholder={f.label}
          />
        ))}
      </div>
      <Button className="mt-3" size="sm" onClick={submit}>
        Submit for approval
      </Button>
    </PanelCard>
  )
}
