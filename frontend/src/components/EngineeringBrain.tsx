import { useEffect, useMemo, useRef, useState } from "react"
import { Cpu, Building2, X, RefreshCw } from "lucide-react"
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — 3d-force-graph ships loose types
import ForceGraph3D from "3d-force-graph"
import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"

/**
 * ADMIN-ONLY "Engineering Brain" — a layered, connected map of Summer.
 *  - System layer: Summer's own architecture (components/agents/tools/stores) with LIVE status.
 *  - Organization layer: the ECE directory (faculty/staff/advisors/courses/areas).
 * Plus live health tiles + Conductor-style flags. Lazy-loaded (three.js). Data:
 * GET /admin/engineering-brain.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any
interface Layer { nodes: Node[]; edges: { source: string; target: string; kind: string }[]; categories: string[] }
interface Health {
  brain: { provider: string; model: string; status: string }
  neo4j: { status: string }; pgvector: { status: string }; embeddings: { status: string }
  coverage: { deterministic_pct: number; llm_pct: number }
  quality: { hallucination_pct: number; fallback_pct: number; open_failures: number }
  flags: { level: string; text: string }[]
}
interface Brain { generated_at: string; health: Health; layers: { system: Layer; organization: Layer } }

// Category palette. Known system layers get intentional colors; anything else is hashed to a
// stable hue so the organization layer (research areas etc.) is colored consistently too.
const CAT_COLORS: Record<string, string> = {
  Interface: "#38bdf8", API: "#22d3ee", Orchestration: "#818cf8", Retrieval: "#a78bfa",
  Data: "#2dd4bf", Voice: "#f472b6", Quality: "#34d399", Delivery: "#fbbf24",
  Course: "#64748b", "Research area": "#f59e0b", Advising: "#fb923c", Staff: "#94a3b8", Unlisted: "#64748b",
}
function hashHue(s: string) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return `hsl(${h % 360}, 55%, 60%)`
}
function catColor(cat: string) {
  return CAT_COLORS[cat] || hashHue(cat || "?")
}
// Health beats category: a broken node should pop red/amber no matter its layer.
const STATUS_COLOR: Record<string, string> = {
  offline: "#ef4444", down: "#ef4444", degraded: "#f59e0b", unconfigured: "#f59e0b",
}
function nodeColor(n: Node) {
  return STATUS_COLOR[n.status] || catColor(n.category)
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
function esc(s: string) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c])
}

const STATUS_PILL: Record<string, string> = {
  live: "text-emerald-400", ready: "text-violet-400", degraded: "text-amber-400",
  unconfigured: "text-amber-400", offline: "text-red-400", down: "text-red-400",
}
function StatusWord({ s }: { s: string }) {
  return <span className={`font-medium ${STATUS_PILL[s] || "text-muted-foreground"}`}>{s}</span>
}

export default function EngineeringBrain() {
  const elRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gRef = useRef<any>(null)
  const [data, setData] = useState<Brain | null>(null)
  const [err, setErr] = useState("")
  const [layer, setLayer] = useState<"system" | "organization">("system")
  const [selected, setSelected] = useState<Node | null>(null)

  async function load() {
    setErr("")
    try {
      setData(await api.get<Brain>("/admin/engineering-brain"))
    } catch {
      setErr("Couldn't load the Engineering Brain.")
    }
  }
  useEffect(() => {
    load()
  }, [])

  const current = data?.layers?.[layer]
  const idx = useMemo(() => {
    const m: Record<string, Node> = {}
    current?.nodes.forEach((n) => (m[n.id] = n))
    return m
  }, [current])

  useEffect(() => {
    setSelected(null)
    if (!current || !elRef.current) return
    const nodes = current.nodes.map((n) => ({ ...n }))
    const links = current.edges
      .filter((e) => idx[e.source] && idx[e.target])
      .map((e) => ({ ...e }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const G = (new ForceGraph3D(elRef.current) as any)
      .backgroundColor("#0a0e18")
      .graphData({ nodes, links })
      .nodeRelSize(5)
      .nodeVal((n: Node) => (["hub", "store", "host", "service", "engine"].includes(n.kind) ? 6 : n.kind === "area" ? 8 : 3))
      .nodeColor((n: Node) => nodeColor(n))
      .nodeOpacity(0.95)
      .nodeLabel((n: Node) =>
        `<div style="font:600 12px Inter,system-ui;color:#e9eefb"><b>${esc(n.name)}</b> · ${esc(n.category)}` +
        (n.status && n.status !== "live" ? ` · <span style="color:#fbbf24">${esc(n.status)}</span>` : "") + `</div>`,
      )
      .linkColor(() => "rgba(120,140,170,0.28)")
      .linkWidth(0.6)
      .onNodeClick((n: Node) => {
        setSelected(n)
        G.cameraPosition(
          { x: (n.x || 0) * 1.35, y: (n.y || 0) * 1.35, z: (n.z || 0) * 1.35 + 120 },
          { x: n.x || 0, y: n.y || 0, z: n.z || 0 }, 800,
        )
      })
      .onBackgroundClick(() => setSelected(null))
    gRef.current = G

    const fit = () => {
      const r = elRef.current!.getBoundingClientRect()
      G.width(r.width).height(r.height)
    }
    fit()
    requestAnimationFrame(fit)
    window.setTimeout(() => G.zoomToFit?.(600, 60), 400)
    window.addEventListener("resize", fit)
    return () => {
      window.removeEventListener("resize", fit)
      try { G._destructor?.() } catch { /* ignore */ }
      gRef.current = null
    }
  }, [current, idx])

  const h = data?.health
  function Tile({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: string; tone?: string }) {
    return (
      <div className="rounded-lg border border-border/60 bg-background/70 px-3 py-2 backdrop-blur">
        <div className={`text-lg font-semibold tabular-nums ${tone || ""}`}>{value}</div>
        <div className="text-[11px] font-medium">{label}</div>
        {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
      </div>
    )
  }

  return (
    <div className="relative w-full overflow-hidden bg-[#0a0e18]" style={{ height: "calc(100svh - 122px)" }}>
      <div ref={elRef} className="absolute inset-0" style={{ display: current ? "block" : "none" }} />
      {err && <p className="absolute inset-0 grid place-items-center p-4 text-sm text-muted-foreground">{err}</p>}
      {!err && !data && <p className="absolute inset-0 grid place-items-center p-4 text-sm text-muted-foreground">Loading the brain…</p>}

      {/* Top-left: layer toggle + live health tiles + flags */}
      <div className="pointer-events-none absolute left-3 top-3 z-10 flex max-w-[min(96vw,560px)] flex-col gap-2">
        <div className="pointer-events-auto flex items-center gap-2">
          <Button size="sm" variant={layer === "system" ? "default" : "outline"} className="h-8 bg-background/80 backdrop-blur" onClick={() => setLayer("system")}>
            <Cpu className="size-4" /> System
          </Button>
          <Button size="sm" variant={layer === "organization" ? "default" : "outline"} className="h-8 bg-background/80 backdrop-blur" onClick={() => setLayer("organization")}>
            <Building2 className="size-4" /> Organization
          </Button>
          <Button size="sm" variant="outline" className="h-8 bg-background/80 backdrop-blur" onClick={load}>
            <RefreshCw className="size-4" /> Refresh
          </Button>
        </div>
        {h && (
          <div className="pointer-events-auto grid grid-cols-3 gap-2">
            <Tile label="AI brain" value={<StatusWord s={h.brain.status} />} sub={h.brain.provider !== "none" ? h.brain.provider : "not set"} />
            <Tile label="Graph store" value={<StatusWord s={h.neo4j.status} />} sub="Neo4j" />
            <Tile label="Vectors" value={<StatusWord s={h.pgvector.status} />} sub="pgvector" />
            <Tile label="Deterministic" value={`${h.coverage.deterministic_pct}%`} sub="answered free" tone="text-emerald-400" />
            <Tile label="Hallucination" value={`${h.quality.hallucination_pct}%`} sub="of AI answers" tone="text-amber-400" />
            <Tile label="Open failures" value={h.quality.open_failures} sub="unresolved" tone={h.quality.open_failures ? "text-red-400" : ""} />
          </div>
        )}
        {h?.flags?.length ? (
          <div className="pointer-events-auto flex flex-col gap-1">
            {h.flags.slice(0, 4).map((f, i) => (
              <div key={i} className={`rounded-md border px-2.5 py-1 text-[11px] backdrop-blur ${f.level === "error" ? "border-red-500/40 bg-red-500/10 text-red-300" : f.level === "warn" ? "border-amber-500/40 bg-amber-500/10 text-amber-200" : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"}`}>
                {f.text}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {/* Legend, bottom-left */}
      {current && (
        <div className="pointer-events-none absolute bottom-3 left-3 z-10 flex max-w-[min(92vw,640px)] flex-wrap gap-x-3 gap-y-1 rounded-lg border border-border/40 bg-background/60 px-3 py-2 text-[10px] text-muted-foreground backdrop-blur">
          {current.categories.map((c) => (
            <span key={c} className="inline-flex items-center gap-1.5">
              <span className="inline-block size-2.5 rounded-full" style={{ background: catColor(c) }} /> {c}
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-full bg-red-500" /> offline/down</span>
        </div>
      )}

      {/* Detail panel */}
      {selected && (
        <div className="absolute right-3 top-3 bottom-3 z-10 w-72 overflow-y-auto rounded-xl border border-border/60 bg-background/90 p-4 backdrop-blur-xl shadow-2xl">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="inline-block size-3 rounded-full" style={{ background: nodeColor(selected) }} />
                <span className="font-semibold leading-tight">{selected.name}</span>
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">{selected.category} · {selected.kind}</div>
            </div>
            <button onClick={() => setSelected(null)} className="text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
          </div>
          <div className="mt-3 space-y-2 text-sm">
            <div>Status: <StatusWord s={selected.status} /></div>
            {selected.purpose && <p className="text-xs leading-relaxed text-muted-foreground">{selected.purpose}</p>}
            {selected.tools && selected.tools !== "—" && (
              <div className="text-xs text-muted-foreground">Tech: <span className="font-mono text-foreground">{selected.tools}</span></div>
            )}
            {selected.office && <div className="text-xs text-muted-foreground">Office: <span className="text-foreground">{selected.office}</span></div>}
            {selected.room && <div className="text-xs text-muted-foreground">Room: <span className="text-foreground">{selected.room}</span></div>}
            {selected.email && <a href={`mailto:${selected.email}`} className="block break-all text-xs text-primary hover:underline">{selected.email}</a>}
            {(() => {
              const deps = (current?.edges || []).filter((e) => e.source === selected.id).map((e) => idx[e.target]).filter(Boolean)
              return deps.length ? (
                <div>
                  <div className="text-xs font-medium text-muted-foreground">Depends on</div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {deps.map((d) => (
                      <button key={d.id} onClick={() => setSelected(d)} className="rounded-full border border-border/60 px-2 py-0.5 text-xs hover:bg-muted/60">{d.name}</button>
                    ))}
                  </div>
                </div>
              ) : null
            })()}
          </div>
        </div>
      )}
    </div>
  )
}
