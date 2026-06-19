import { useEffect, useState } from "react"
import { api, type EmailDraft } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { PanelCard } from "@/components/panels/PanelCard"
import { toast } from "sonner"

export default function DraftsPanel({ reloadKey }: { reloadKey?: number }) {
  const [items, setItems] = useState<EmailDraft[]>([])

  async function load() {
    try {
      setItems(await api.get<EmailDraft[]>("/emails"))
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    load()
  }, [reloadKey])

  async function send(id: number) {
    const d = await api.post<{ sent?: boolean; real?: boolean; to?: string; error?: string }>(
      `/emails/${id}/send`,
    )
    if (d.sent) toast.success(`Email ${d.real ? "sent" : "sent (simulated)"} to ${d.to}`)
    else toast.error(d.error || "Could not send")
    load()
  }
  async function discard(id: number) {
    await api.post(`/emails/${id}/discard`)
    load()
  }

  return (
    <PanelCard title="Email drafts">
      <ul className="divide-y">
        {items.map((d) => (
          <li key={d.id} className="flex items-start gap-2 py-2 text-sm">
            <div className="flex-1">
              <div className="font-medium">{d.subject || "(no subject)"}</div>
              <div className="text-xs text-muted-foreground">
                to {d.to || "?"} — {d.body}
              </div>
            </div>
            <Button size="sm" onClick={() => send(d.id)}>
              Send
            </Button>
            <Button variant="ghost" size="sm" onClick={() => discard(d.id)}>
              ×
            </Button>
          </li>
        ))}
        {items.length === 0 && (
          <li className="py-2 text-sm text-muted-foreground">none</li>
        )}
      </ul>
    </PanelCard>
  )
}
