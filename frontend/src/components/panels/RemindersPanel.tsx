import { useEffect, useState } from "react"
import { api, type Reminder } from "@/lib/api"
import { PanelCard } from "@/components/panels/PanelCard"

export default function RemindersPanel({ reloadKey }: { reloadKey?: number }) {
  const [items, setItems] = useState<Reminder[]>([])

  async function load() {
    try {
      setItems(await api.get<Reminder[]>("/reminders"))
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    load()
    const id = setInterval(load, 30000)
    return () => clearInterval(id)
  }, [reloadKey])

  return (
    <PanelCard title="Reminders">
      <ul className="divide-y">
        {items.map((r) => (
          <li key={r.id} className="flex items-center gap-2 py-2 text-sm">
            <span className="flex-1">{r.text}</span>
            <span className="text-xs text-muted-foreground">
              {r.due ? "now" : new Date(r.remind_at).toLocaleString()}
            </span>
          </li>
        ))}
        {items.length === 0 && (
          <li className="py-2 text-sm text-muted-foreground">none yet</li>
        )}
      </ul>
    </PanelCard>
  )
}
