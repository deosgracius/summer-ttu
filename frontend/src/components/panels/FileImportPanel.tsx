import { useRef, useState } from "react"
import { api, getToken } from "@/lib/api"
import { PanelCard } from "@/components/panels/PanelCard"
import { Button } from "@/components/ui/button"

/** Admin file import: upload a data file, Summer security-checks it, says what it
 * found, and proposes what to do. Nothing is written until you click Apply. */
interface Proposal {
  ok: boolean
  error?: string
  kind?: string
  columns?: string[]
  count?: number
  preview?: Record<string, string>[]
  rows?: Record<string, string>[]
  suggestions?: string[]
  filename?: string
}

export default function FileImportPanel() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [prop, setProp] = useState<Proposal | null>(null)
  const [result, setResult] = useState<string>("")

  async function analyze(file: File) {
    setProp(null)
    setResult("")
    setBusy(true)
    try {
      const fd = new FormData()
      fd.append("file", file, file.name)
      const r = await fetch("/admin/import/analyze", {
        method: "POST",
        headers: { ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) },
        body: fd,
      })
      setProp(await r.json())
    } catch {
      setProp({ ok: false, error: "Upload failed — check your connection." })
    } finally {
      setBusy(false)
    }
  }

  async function apply() {
    if (!prop?.kind || !prop.rows) return
    setBusy(true)
    try {
      const res = await api.post<{ applied: boolean; summary?: string; error?: string }>(
        "/admin/import/apply", { kind: prop.kind, rows: prop.rows })
      setResult(res.applied ? (res.summary || "Applied.") : (res.error || "Couldn't apply."))
      if (res.applied) setProp(null)
    } catch {
      setResult("Apply failed — check your connection.")
    } finally {
      setBusy(false)
    }
  }

  const canApply = prop?.ok && prop.kind === "office_hours"

  return (
    <PanelCard title="Import a file">
      <p className="text-sm text-muted-foreground">
        Upload a CSV, XLSX, JSON, or text file (e.g. professors' office hours). Summer
        checks it for safety, tells you what it found, and proposes what to do — nothing
        is saved until you confirm.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.tsv,.txt,.json,.xlsx"
          className="text-sm"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) analyze(f)
          }}
        />
        {busy && <span className="text-xs text-muted-foreground">Working…</span>}
      </div>

      {prop && !prop.ok && (
        <p className="mt-3 text-sm text-red-500">⚠ {prop.error}</p>
      )}

      {prop && prop.ok && (
        <div className="mt-4 space-y-2">
          <div className="text-sm">
            <span className="font-medium">{prop.filename}</span> — looks like{" "}
            <span className="font-medium">{prop.kind?.replace("_", " ")}</span> ·{" "}
            {prop.count} row{prop.count === 1 ? "" : "s"}
          </div>
          {prop.suggestions?.map((s, i) => (
            <p key={i} className="text-sm text-muted-foreground">• {s}</p>
          ))}
          {prop.preview && prop.preview.length > 0 && (
            <div className="mt-2 overflow-x-auto rounded border">
              <table className="w-full text-xs">
                <thead className="bg-muted/50">
                  <tr>{prop.columns?.map((c) => <th key={c} className="px-2 py-1 text-left font-medium">{c}</th>)}</tr>
                </thead>
                <tbody>
                  {prop.preview.map((row, i) => (
                    <tr key={i} className="border-t">
                      {prop.columns?.map((c) => <td key={c} className="px-2 py-1">{row[c]}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {canApply ? (
            <Button size="sm" className="mt-2" disabled={busy} onClick={apply}>
              Apply — update office hours
            </Button>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">
              Preview only — this type isn't auto-applied yet. Tell me what you'd like done with it.
            </p>
          )}
        </div>
      )}

      {result && <p className="mt-3 text-sm">{result}</p>}
    </PanelCard>
  )
}
