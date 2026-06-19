import { useEffect, useState } from "react"
import { api, type Memory } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { PanelCard } from "@/components/panels/PanelCard"

export default function MemoriesPanel({ reloadKey }: { reloadKey?: number }) {
  const [items, setItems] = useState<Memory[]>([])

  async function load() {
    try {
      setItems(await api.get<Memory[]>("/memories"))
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    load()
  }, [reloadKey])

  async function forget(id: number) {
    await api.del(`/memories/${id}`)
    load()
  }

  return (
    <PanelCard title="Memories" className="md:col-span-2">
      <ul className="divide-y">
        {items.map((m) => (
          <li key={m.id} className="flex items-center gap-2 py-2 text-sm">
            <span className="flex-1">{m.text}</span>
            <Button variant="ghost" size="sm" onClick={() => forget(m.id)}>
              forget
            </Button>
          </li>
        ))}
        {items.length === 0 && (
          <li className="py-2 text-sm text-muted-foreground">
            Tell Summer to “remember” something.
          </li>
        )}
      </ul>
    </PanelCard>
  )
}
