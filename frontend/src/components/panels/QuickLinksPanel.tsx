import { useEffect, useState } from "react"
import { api } from "@/lib/api"
import { useAuth } from "@/lib/auth"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { PanelCard } from "@/components/panels/PanelCard"
import { toast } from "sonner"

/** Admin only. Name a URL so Summer can open it by voice — e.g. name "gantt chart",
 * then say "Hey Summer, open my gantt chart" on the dashboard. */
export default function QuickLinksPanel() {
  const { me } = useAuth()
  const canManage = me?.role === "admin" || me?.role === "central_admin"
  const [links, setLinks] = useState<Record<string, string>>({})
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const [saving, setSaving] = useState(false)

  async function load() {
    try {
      setLinks(await api.get<Record<string, string>>("/admin/links"))
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    if (canManage) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage])

  if (!canManage) return null

  async function add() {
    if (!name.trim() || !url.trim()) return
    setSaving(true)
    try {
      setLinks(await api.post<Record<string, string>>("/admin/links", { name: name.trim(), url: url.trim() }))
      setName("")
      setUrl("")
      toast.success("Quick link saved")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save link")
    } finally {
      setSaving(false)
    }
  }

  async function remove(n: string) {
    try {
      setLinks(await api.del<Record<string, string>>(`/admin/links/${encodeURIComponent(n)}`))
      toast.success(`Removed "${n}"`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not remove link")
    }
  }

  const entries = Object.entries(links)
  return (
    <PanelCard title="Quick Links">
      <p className="text-xs text-muted-foreground">
        Name a URL so Summer can open it by voice on this dashboard — e.g. name it
        "gantt chart", then say "Hey Summer, open my gantt chart." http(s) links only.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder='name (e.g. "gantt chart")' className="w-52" />
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" className="flex-1 min-w-[12rem]" />
        <Button size="sm" onClick={add} disabled={saving}>
          {saving ? "Saving…" : "Add"}
        </Button>
      </div>
      <ul className="mt-3 divide-y">
        {entries.length === 0 && <li className="py-2 text-sm text-muted-foreground">No quick links yet.</li>}
        {entries.map(([n, u]) => (
          <li key={n} className="flex items-center gap-3 py-2 text-sm">
            <span className="font-medium shrink-0">{n}</span>
            <a href={u} target="_blank" rel="noopener" className="flex-1 truncate text-primary/80 hover:underline">
              {u}
            </a>
            <button
              onClick={() => remove(n)}
              className="shrink-0 rounded-md border border-destructive/50 px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    </PanelCard>
  )
}
