import { useEffect, useMemo, useRef, useState } from "react"
import { api, getToken, type CampusRow } from "@/lib/api"
import { useAuth } from "@/lib/auth"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { PanelCard } from "@/components/panels/PanelCard"
import { toast } from "sonner"

/** Field definitions per campus resource — drives form, table, and search. */
type Field = { key: string; label: string }
type Resource = {
  path: string
  label: string
  fields: Field[]
  /** keys joined for the bold row heading (defaults to first field) */
  headingKeys?: string[]
}

const RESOURCES: Resource[] = [
  {
    path: "courses",
    label: "Courses",
    headingKeys: ["subject", "course", "section", "title"],
    fields: [
      { key: "crn", label: "CRN" },
      { key: "subject", label: "Subject" },
      { key: "course", label: "Course #" },
      { key: "section", label: "Section" },
      { key: "title", label: "Title" },
      { key: "prerequisites", label: "Prerequisites" },
      { key: "permit_required", label: "Permit required?" },
      { key: "days", label: "Days" },
      { key: "times", label: "Times" },
      { key: "building", label: "Building" },
      { key: "room_number", label: "Room #" },
      { key: "instructor", label: "Instructor" },
      { key: "campus", label: "Campus" },
      { key: "semester", label: "Semester" },
    ],
  },
  {
    path: "professors",
    label: "Professors",
    fields: [
      { key: "name", label: "Name" },
      { key: "department", label: "Department" },
      { key: "email", label: "Email" },
      { key: "office_building", label: "Office building" },
      { key: "office_number", label: "Office #" },
      { key: "office_hours", label: "Office hours" },
      { key: "office_hours_policy", label: "Policy" },
      { key: "semester", label: "Semester" },
    ],
  },
  {
    path: "advisors",
    label: "Advisors",
    fields: [
      { key: "name", label: "Name" },
      { key: "department", label: "Department" },
      { key: "email", label: "Email" },
      { key: "office_building", label: "Office building" },
      { key: "office_number", label: "Office #" },
      { key: "schedule", label: "Schedule" },
      { key: "availability", label: "Availability" },
      { key: "semester", label: "Semester" },
    ],
  },
  {
    path: "buildings",
    label: "Buildings",
    fields: [
      { key: "name", label: "Name" },
      { key: "code", label: "Code" },
      { key: "address", label: "Address" },
      { key: "description", label: "Description" },
      { key: "hours_text", label: "Hours" },
      { key: "semester", label: "Semester" },
    ],
  },
  {
    path: "services",
    label: "Services",
    fields: [
      { key: "name", label: "Name" },
      { key: "location", label: "Location" },
      { key: "hours_text", label: "Hours" },
      { key: "policy", label: "Policy" },
      { key: "semester", label: "Semester" },
    ],
  },
  {
    path: "availability",
    label: "Tutors/Officers",
    headingKeys: ["name", "role_label"],
    fields: [
      { key: "name", label: "Name" },
      { key: "role_label", label: "Role (Tutor / IEEE President)" },
      { key: "subjects", label: "Subjects / focus" },
      { key: "location", label: "Location" },
      { key: "schedule", label: "Availability" },
      { key: "notes", label: "Notes" },
      { key: "semester", label: "Semester" },
    ],
  },
  {
    path: "catalog",
    label: "Catalog",
    headingKeys: ["code", "title"],
    fields: [
      { key: "category", label: "Category" },
      { key: "code", label: "Code" },
      { key: "title", label: "Title" },
      { key: "prerequisites", label: "Prerequisites" },
      { key: "notes", label: "Notes" },
      { key: "catalog_year", label: "Catalog year" },
    ],
  },
]

function emptyDraft(res: Resource): Record<string, string> {
  return Object.fromEntries(res.fields.map((f) => [f.key, ""]))
}

function heading(res: Resource, row: CampusRow): string {
  const keys = res.headingKeys ?? [res.fields[0].key]
  return keys.map((k) => String(row[k] ?? "")).filter(Boolean).join(" · ") || "(untitled)"
}

// ---- Admin import widget -------------------------------------------------

interface ImportResult {
  preview?: boolean
  pending?: boolean
  applied?: boolean
  offerings_found?: number
  catalog_found?: number
  offerings?: { added: number; updated: number }
  catalog?: { added: number; updated: number }
  sheets?: { name: string; type: string; count: number; skipped: number }[]
}

function ImportWidget({ onDone }: { onDone: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)

  async function send(commit: boolean) {
    if (!file) {
      toast.error("Choose an .xlsx file first")
      return
    }
    setBusy(true)
    try {
      const form = new FormData()
      form.append("file", file)
      form.append("commit", commit ? "true" : "false")
      const res = await fetch("/campus/import", {
        method: "POST",
        headers: { Authorization: `Bearer ${getToken()}` },
        body: form,
      })
      const data = (await res.json()) as ImportResult & { detail?: string }
      if (!res.ok) throw new Error(data.detail || "Import failed")
      setResult(data)
      if (commit) {
        toast.success(data.pending ? "Import submitted for approval" : "Imported")
        onDone()
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Import failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground mb-2">
        Import a registrar spreadsheet (.xlsx) — preview first, then commit.
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xlsm"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null)
            setResult(null)
          }}
          className="text-xs file:mr-2 file:rounded file:border-0 file:bg-secondary file:px-2 file:py-1 file:text-secondary-foreground"
        />
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => send(false)}>
          Preview
        </Button>
        <Button size="sm" disabled={busy || !result?.preview} onClick={() => send(true)}>
          Commit
        </Button>
      </div>

      {result && (
        <div className="mt-3 text-xs space-y-1">
          {result.preview ? (
            <div className="text-muted-foreground">
              Found <b>{result.offerings_found}</b> course sections and{" "}
              <b>{result.catalog_found}</b> catalog entries. Review below, then Commit.
            </div>
          ) : result.pending ? (
            <div className="text-amber-400">
              Submitted for approval — a central admin must approve before it goes
              live on the kiosk.
            </div>
          ) : (
            <div className="text-emerald-400">
              Saved — courses +{result.offerings?.added}/~{result.offerings?.updated} updated,
              catalog +{result.catalog?.added}/~{result.catalog?.updated} updated.
            </div>
          )}
          {result.sheets?.map((s) => (
            <div key={s.name} className="text-muted-foreground">
              · {s.name} ({s.type}): {s.count} rows
              {s.skipped ? `, ${s.skipped} non-data rows skipped` : ""}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ---- Main panel ----------------------------------------------------------

export default function CampusPanel({ reloadKey }: { reloadKey?: number }) {
  const { me } = useAuth()
  const isAdmin = me?.role === "admin" || me?.role === "central_admin"
  const [active, setActive] = useState<Resource>(RESOURCES[0])
  const [rows, setRows] = useState<CampusRow[]>([])
  const [q, setQ] = useState("")
  const [draft, setDraft] = useState<Record<string, string>>(emptyDraft(RESOURCES[0]))
  const [editingId, setEditingId] = useState<number | null>(null)
  const [showImport, setShowImport] = useState(false)
  const [open, setOpen] = useState(false) // hidden until clicked

  async function load() {
    try {
      setRows(await api.get<CampusRow[]>(`/campus/${active.path}`))
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    load()
    setDraft(emptyDraft(active))
    setEditingId(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, reloadKey])

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase()
    const list = !term
      ? rows
      : rows.filter((r) =>
          active.fields.some((f) => String(r[f.key] ?? "").toLowerCase().includes(term)),
        )
    // sorted by display heading for an organized, scannable list
    return [...list].sort((a, b) => heading(active, a).localeCompare(heading(active, b)))
  }, [rows, q, active])

  // Group by the first heading key (e.g. courses by subject) for clean sections.
  const grouped = useMemo(() => {
    const key = active.headingKeys?.[0] ?? active.fields[0].key
    const map = new Map<string, CampusRow[]>()
    for (const r of filtered) {
      const g = String(r[key] ?? "—") || "—"
      if (!map.has(g)) map.set(g, [])
      map.get(g)!.push(r)
    }
    return [...map.entries()]
  }, [filtered, active])

  async function save() {
    try {
      const res =
        editingId != null
          ? await api.patch<{ pending?: boolean }>(`/campus/${active.path}/${editingId}`, draft)
          : await api.post<{ pending?: boolean }>(`/campus/${active.path}`, draft)
      toast.success(
        res?.pending
          ? "Submitted for approval"
          : editingId != null
            ? "Updated"
            : "Added",
      )
      setDraft(emptyDraft(active))
      setEditingId(null)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed")
    }
  }

  function startEdit(row: CampusRow) {
    setEditingId(row.id)
    setDraft(
      Object.fromEntries(active.fields.map((f) => [f.key, String(row[f.key] ?? "")])),
    )
  }

  async function remove(id: number) {
    try {
      const res = await api.del<{ pending?: boolean }>(`/campus/${active.path}/${id}`)
      toast.success(res?.pending ? "Delete submitted for approval" : "Deleted")
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed")
    }
  }

  // The raw data tables are admin-only — students use the kiosk, and
  // tutors/officers never see them on the webpage.
  if (!isAdmin) return null

  return (
    <PanelCard title="Campus Data">
      {/* Hidden until clicked */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm hover:bg-muted/40"
      >
        <span>Open data manager — courses, professors, advisors, buildings &amp; services</span>
        <span className="text-muted-foreground">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="mt-3">
          {/* Resource tabs */}
          <div className="flex flex-wrap gap-2">
            {RESOURCES.map((r) => (
              <Button
                key={r.path}
                size="sm"
                variant={r.path === active.path ? "secondary" : "ghost"}
                onClick={() => setActive(r)}
              >
                {r.label}
              </Button>
            ))}
          </div>

          <div className="mt-3 flex gap-2">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`Search ${active.label.toLowerCase()}…`}
            />
            <Button variant="outline" size="sm" onClick={() => setShowImport((v) => !v)}>
              Import file
            </Button>
          </div>

          {showImport && (
            <div className="mt-3">
              <ImportWidget onDone={load} />
            </div>
          )}

          {/* Add / edit form */}
          <div className="mt-4 rounded-md border p-3">
            <div className="text-xs text-muted-foreground mb-2">
              {editingId != null ? "Edit entry" : "Add new entry"}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {active.fields.map((f) => (
                <Input
                  key={f.key}
                  value={draft[f.key] ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                  placeholder={f.label}
                />
              ))}
            </div>
            <div className="mt-2 flex gap-2">
              <Button size="sm" onClick={save}>
                {editingId != null ? "Save" : "Add"}
              </Button>
              {editingId != null && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditingId(null)
                    setDraft(emptyDraft(active))
                  }}
                >
                  Cancel
                </Button>
              )}
            </div>
          </div>

          {/* Grouped, organized, easy-to-read entries */}
          <div className="mt-3 text-xs text-muted-foreground">
            {filtered.length} {active.label.toLowerCase()}
          </div>
          <div className="mt-1 max-h-[28rem] overflow-auto space-y-3 pr-1">
            {grouped.map(([group, items]) => (
              <div key={group}>
                <div className="sticky top-0 z-10 bg-card/95 backdrop-blur text-xs font-medium text-primary/80 py-1">
                  {group} <span className="text-muted-foreground">({items.length})</span>
                </div>
                <ul className="divide-y">
                  {items.map((row) => (
                    <li key={row.id} className="py-2">
                      <div className="flex items-start justify-between gap-3">
                        <div className="font-medium text-sm">{heading(active, row)}</div>
                        <div className="flex gap-1 shrink-0">
                          <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => startEdit(row)}>
                            Edit
                          </Button>
                          <Button variant="ghost" size="icon" className="size-7" onClick={() => remove(row.id)}>
                            ×
                          </Button>
                        </div>
                      </div>
                      <div className="mt-1 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-0.5 text-xs">
                        {active.fields
                          .filter((f) => !(active.headingKeys ?? [active.fields[0].key]).includes(f.key))
                          .map((f) => {
                            const v = String(row[f.key] ?? "")
                            if (!v) return null
                            return (
                              <div key={f.key} className="truncate">
                                <span className="text-muted-foreground">{f.label}: </span>
                                <span className="text-foreground">{v}</span>
                              </div>
                            )
                          })}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {filtered.length === 0 && (
              <div className="py-2 text-sm text-muted-foreground">No entries.</div>
            )}
          </div>
        </div>
      )}
    </PanelCard>
  )
}
