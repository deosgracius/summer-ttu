import { useEffect, useState } from "react"
import { RefreshCw, CheckCircle2, AlertTriangle, AlertOctagon, Trash2 } from "lucide-react"
import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { PanelCard } from "@/components/panels/PanelCard"
import { toast } from "sonner"

interface Failure {
  id: number
  source: string
  severity: string
  summary: string
  detail: string | null
  count: number
  resolved: boolean
  first_seen: string
  last_seen: string
}
interface FailureReport {
  enabled: boolean
  open: number
  items: Failure[]
}

function ago(iso: string): string {
  if (!iso) return ""
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/**
 * CENTRAL ADMIN ONLY: the operational failure log. Shows what has broken (LLM/voice down,
 * unhandled errors), deduped with a count and last-seen, so the central admin can see and
 * fix issues instead of them being buried in server logs. Render only for central_admin.
 */
export default function FailureLogPanel() {
  const [d, setD] = useState<FailureReport | null>(null)
  const [showResolved, setShowResolved] = useState(false)
  const [loading, setLoading] = useState(false)

  async function load() {
    setLoading(true)
    try {
      setD(await api.get<FailureReport>(`/admin/failures?resolved=${showResolved ? 1 : 0}`))
    } catch {
      /* ignore */
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showResolved])

  async function resolve(id: number) {
    try {
      await api.post(`/admin/failures/${id}/resolve`)
      load()
    } catch {
      toast.error("Couldn't mark it fixed")
    }
  }
  async function clearResolved() {
    try {
      await api.del("/admin/failures")
      toast.success("Cleared fixed items")
      load()
    } catch {
      toast.error("Couldn't clear")
    }
  }

  const Icon = (sev: string) => (sev === "warning" ? AlertTriangle : AlertOctagon)

  return (
    <PanelCard
      title="System failures"
      action={
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => setShowResolved((v) => !v)}>
            {showResolved ? "Hide fixed" : "Show fixed"}
          </Button>
          <Button size="sm" variant="outline" onClick={load} disabled={loading}>
            <RefreshCw className="size-4" /> Refresh
          </Button>
        </div>
      }
    >
      <p className="text-sm text-muted-foreground">
        Anything that breaks — the AI brain unreachable, voice failing, an unexpected error — is
        recorded here (deduped with a count) so you can see and fix it. Mark an item fixed once
        you've handled it.
      </p>

      {!d ? (
        <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
      ) : !d.enabled ? (
        <p className="mt-3 text-sm text-muted-foreground">Failure logging is off (FAILURE_LOG=0).</p>
      ) : d.items.length === 0 ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-emerald-400">
          <CheckCircle2 className="size-4" /> All clear — no {showResolved ? "" : "open "}failures recorded.
        </p>
      ) : (
        <div className="mt-4 space-y-2">
          <div className="text-xs text-muted-foreground">
            {d.open} open issue{d.open === 1 ? "" : "s"}.
          </div>
          {d.items.map((f) => {
            const Sev = Icon(f.severity)
            return (
              <div
                key={f.id}
                className={`rounded-lg border p-3 ${f.resolved ? "border-border/40 opacity-60" : "border-border/60"}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-2">
                    <Sev className={`mt-0.5 size-4 shrink-0 ${f.severity === "warning" ? "text-amber-400" : "text-red-400"}`} />
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{f.summary}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        <span className="rounded bg-muted px-1.5 py-0.5">{f.source}</span>
                        {f.count > 1 && <span className="ml-2">×{f.count}</span>}
                        <span className="ml-2">last {ago(f.last_seen)}</span>
                      </div>
                      {f.detail && (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-xs text-muted-foreground">details</summary>
                          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/50 p-2 text-[11px] text-muted-foreground">
                            {f.detail}
                          </pre>
                        </details>
                      )}
                    </div>
                  </div>
                  {!f.resolved && (
                    <Button size="sm" variant="ghost" className="shrink-0" onClick={() => resolve(f.id)} title="Mark fixed">
                      <CheckCircle2 className="size-4" /> Fixed
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
          {showResolved && (
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={clearResolved}>
              <Trash2 className="size-4" /> Clear fixed items
            </Button>
          )}
        </div>
      )}
    </PanelCard>
  )
}
