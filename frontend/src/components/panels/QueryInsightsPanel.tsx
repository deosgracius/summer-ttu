import { useEffect, useState } from "react"
import { RefreshCw, Trash2 } from "lucide-react"
import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { PanelCard } from "@/components/panels/PanelCard"
import { toast } from "sonner"

interface Insights {
  enabled: boolean
  total: number
  by_answer: { deterministic: number; llm: number; fallback: number }
  by_surface: Record<string, number>
  deterministic_pct: number
  llm_pct: number
  top_llm_queries: { query: string; count: number }[]
  recent_llm: { query: string; surface: string; provider: string; at: string }[]
}

/**
 * Admin view of how often Summer answers instantly from the database vs. paying the LLM.
 * The LLM-answered questions are candidates for a new deterministic rule — adding one makes
 * that question free, instant, and offline-proof, WITHOUT changing accuracy. Anonymized:
 * the underlying log stores no identity or IP, and redacts obvious PII.
 */
export default function QueryInsightsPanel() {
  const [d, setD] = useState<Insights | null>(null)
  const [loading, setLoading] = useState(false)

  async function load() {
    setLoading(true)
    try {
      setD(await api.get<Insights>("/admin/query-insights"))
    } catch {
      /* ignore */
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    load()
  }, [])

  async function clear() {
    if (!window.confirm("Clear the anonymized question log?")) return
    try {
      await api.del("/admin/query-insights")
      toast.success("Question log cleared")
      load()
    } catch {
      toast.error("Couldn't clear the log")
    }
  }

  return (
    <PanelCard
      title="Instant vs. LLM coverage"
      action={
        <div className="flex gap-1">
          <Button size="sm" variant="outline" onClick={load} disabled={loading}>
            <RefreshCw className="size-4" /> Refresh
          </Button>
          {d && d.total > 0 && (
            <Button size="sm" variant="ghost" onClick={clear} title="Clear the log">
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
      }
    >
      <p className="text-sm text-muted-foreground">
        How often Summer answers instantly from the database vs. paying the LLM. The
        LLM-answered questions below are candidates for a new deterministic rule — adding one
        makes that question free, instant, and offline-proof, without changing accuracy.
        Anonymized: no identity or IP is stored.
      </p>

      {!d ? (
        <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
      ) : d.total === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          {d.enabled
            ? "No questions logged yet. Ask Summer a few things, then refresh."
            : "Insights are turned off (QUERY_INSIGHTS=0)."}
        </p>
      ) : (
        <div className="mt-4 space-y-5">
          {/* Coverage ratio */}
          <div>
            <div className="mb-1 flex justify-between text-xs text-muted-foreground">
              <span>
                Instant (database): <b className="text-foreground">{d.deterministic_pct}%</b>
              </span>
              <span>
                Used the LLM: <b className="text-foreground">{d.llm_pct}%</b>
              </span>
            </div>
            <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-emerald-400" style={{ width: `${d.deterministic_pct}%` }} />
              <div className="h-full bg-amber-400" style={{ width: `${d.llm_pct}%` }} />
            </div>
            <div className="mt-1.5 text-xs text-muted-foreground">
              {d.total} questions · {d.by_answer.deterministic} instant · {d.by_answer.llm} LLM ·{" "}
              {d.by_answer.fallback} offline-fallback
            </div>
          </div>

          {/* Gap candidates */}
          {d.top_llm_queries.length > 0 && (
            <div>
              <div className="text-sm font-medium">Most common LLM questions — rule candidates</div>
              <ul className="mt-2 space-y-1">
                {d.top_llm_queries.map((q, i) => (
                  <li key={i} className="flex items-center justify-between gap-3 text-sm">
                    <span className="truncate">{q.query}</span>
                    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      ×{q.count}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Recent */}
          {d.recent_llm.length > 0 && (
            <details>
              <summary className="cursor-pointer text-sm font-medium">
                Recent LLM-answered questions ({d.recent_llm.length})
              </summary>
              <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                {d.recent_llm.map((r, i) => (
                  <li key={i} className="truncate">
                    <span className="text-foreground">{r.query}</span> · {r.surface}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </PanelCard>
  )
}
