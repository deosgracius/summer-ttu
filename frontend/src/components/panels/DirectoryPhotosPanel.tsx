import { useEffect, useRef, useState } from "react"
import { api, getToken } from "@/lib/api"
import { useAuth } from "@/lib/auth"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PanelCard } from "@/components/panels/PanelCard"
import { toast } from "sonner"

// One directory person, as returned by GET /campus/directory-admin. `resource` is the backing
// table ("professors" | "staff"); `id` is that row's database id. Editing, deleting, or setting a
// photo here writes that exact row — the same row the kiosk sleep-screen reads.
interface DirPerson {
  resource: "professors" | "staff"
  id: number
  name: string
  title: string
  office: string
  photo_url: string
  email: string
  office_building: string
  office_number: string
  office_hours: string
}
interface DirSection {
  key: string
  title: string
  members: DirPerson[]
}

type EditForm = {
  name: string
  title: string
  email: string
  office_building: string
  office_number: string
  office_hours: string
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join("")
}

/**
 * Directory — the one place to manage the people Summer shows on the kiosk: add someone, edit
 * their name / title / email / office / office hours, replace or remove their photo, or remove
 * them entirely. Every change writes the Professor/Staff row the kiosk reads, so it appears on
 * the wall within a minute. Built for a non-technical operator: plain labels, big buttons, and a
 * confirmation before anything is deleted.
 */
export default function DirectoryPhotosPanel() {
  const { me } = useAuth()
  const isAdmin = me?.role === "admin" || me?.role === "central_admin"
  const [open, setOpen] = useState(false)
  const [sections, setSections] = useState<DirSection[]>([])
  const [busy, setBusy] = useState<string | null>(null) // "resource:id" currently working
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({})

  const [editing, setEditing] = useState<string | null>(null) // key currently being edited
  const [form, setForm] = useState<EditForm | null>(null)

  const [adding, setAdding] = useState(false)
  const [addForm, setAddForm] = useState<EditForm & { resource: "professors" | "staff" }>({
    resource: "professors", name: "", title: "", email: "",
    office_building: "", office_number: "", office_hours: "",
  })

  async function load() {
    try {
      const res = await api.get<{ sections: DirSection[] }>("/campus/directory-admin")
      setSections(res.sections || [])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't load the directory")
    }
  }
  useEffect(() => {
    if (isAdmin && open) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, open])

  if (!isAdmin) return null

  const keyOf = (p: DirPerson) => `${p.resource}:${p.id}`

  async function upload(p: DirPerson, file: File) {
    const k = keyOf(p)
    if (!/^image\/(jpeg|png|gif|webp)$/.test(file.type)) {
      toast.error("Please choose a JPEG, PNG, GIF, or WebP image.")
      return
    }
    if (file.size > 6 * 1024 * 1024) {
      toast.error("Image too large — please keep it under 6 MB.")
      return
    }
    setBusy(k)
    try {
      const fd = new FormData()
      fd.append("file", file, file.name)
      const r = await fetch(`/campus/${p.resource}/${p.id}/photo`, {
        method: "POST",
        headers: { ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) },
        body: fd,
      })
      if (!r.ok) {
        const detail = await r.json().catch(() => null)
        throw new Error(detail?.detail || `Upload failed (${r.status})`)
      }
      toast.success("Photo updated")
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed")
    } finally {
      setBusy(null)
    }
  }

  async function removePhoto(p: DirPerson) {
    const k = keyOf(p)
    setBusy(k)
    try {
      await api.del(`/campus/${p.resource}/${p.id}/photo`)
      toast.success("Photo removed")
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't remove the photo")
    } finally {
      setBusy(null)
    }
  }

  function startEdit(p: DirPerson) {
    setEditing(keyOf(p))
    setForm({
      name: p.name, title: p.title, email: p.email,
      office_building: p.office_building, office_number: p.office_number,
      office_hours: p.office_hours,
    })
  }

  async function saveEdit(p: DirPerson) {
    if (!form) return
    if (!form.name.trim()) {
      toast.error("A name is required.")
      return
    }
    const k = keyOf(p)
    setBusy(k)
    try {
      // Staff rows have no office_hours field — only send it for professors.
      const body: Partial<EditForm> = {
        name: form.name.trim(), title: form.title.trim(), email: form.email.trim(),
        office_building: form.office_building.trim(), office_number: form.office_number.trim(),
      }
      if (p.resource === "professors") body.office_hours = form.office_hours.trim()
      await api.patch(`/campus/${p.resource}/${p.id}`, body)
      toast.success("Saved")
      setEditing(null)
      setForm(null)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save")
    } finally {
      setBusy(null)
    }
  }

  async function deletePerson(p: DirPerson) {
    if (!window.confirm(`Remove ${p.name} from the directory? They will disappear from the kiosk.`)) return
    const k = keyOf(p)
    setBusy(k)
    try {
      await api.del(`/campus/${p.resource}/${p.id}`)
      toast.success(`${p.name} removed`)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't remove this person")
    } finally {
      setBusy(null)
    }
  }

  async function addPerson() {
    if (!addForm.name.trim()) {
      toast.error("A name is required.")
      return
    }
    setBusy("add")
    try {
      const body: Record<string, string> = {
        name: addForm.name.trim(), title: addForm.title.trim(), email: addForm.email.trim(),
        office_building: addForm.office_building.trim(), office_number: addForm.office_number.trim(),
      }
      if (addForm.resource === "professors") body.office_hours = addForm.office_hours.trim()
      await api.post(`/campus/${addForm.resource}`, body)
      toast.success(`${addForm.name} added`)
      setAdding(false)
      setAddForm({ resource: "professors", name: "", title: "", email: "", office_building: "", office_number: "", office_hours: "" })
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't add this person")
    } finally {
      setBusy(null)
    }
  }

  const total = sections.reduce((n, s) => n + s.members.length, 0)

  return (
    <PanelCard title="Directory — people & photos">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm hover:bg-muted/40"
      >
        <span>Add, edit, or remove the people (and photos) shown on the kiosk</span>
        <span className="text-muted-foreground">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Every change here appears on the kiosk within a minute.
            </p>
            <Button size="sm" onClick={() => setAdding((a) => !a)} disabled={busy === "add"}>
              {adding ? "Cancel" : "+ Add a person"}
            </Button>
          </div>

          {adding && (
            <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
              <div className="flex gap-2">
                <label className="text-xs text-muted-foreground flex items-center gap-1.5">
                  Type:
                  <select
                    value={addForm.resource}
                    onChange={(e) => setAddForm((f) => ({ ...f, resource: e.target.value as "professors" | "staff" }))}
                    className="rounded border bg-background px-2 py-1 text-sm"
                  >
                    <option value="professors">Faculty / Instructor</option>
                    <option value="staff">Staff</option>
                  </select>
                </label>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Name (required)" value={addForm.name} onChange={(v) => setAddForm((f) => ({ ...f, name: v }))} />
                <Field label="Title" value={addForm.title} onChange={(v) => setAddForm((f) => ({ ...f, title: v }))} />
                <Field label="Email" value={addForm.email} onChange={(v) => setAddForm((f) => ({ ...f, email: v }))} />
                <Field label="Office building" value={addForm.office_building} onChange={(v) => setAddForm((f) => ({ ...f, office_building: v }))} />
                <Field label="Office number" value={addForm.office_number} onChange={(v) => setAddForm((f) => ({ ...f, office_number: v }))} />
                {addForm.resource === "professors" && (
                  <Field label="Office hours" value={addForm.office_hours} onChange={(v) => setAddForm((f) => ({ ...f, office_hours: v }))} />
                )}
              </div>
              <Button size="sm" onClick={addPerson} disabled={busy === "add" || !addForm.name.trim()}>
                {busy === "add" ? "Adding…" : "Add to directory"}
              </Button>
            </div>
          )}

          <div className="max-h-[36rem] overflow-auto space-y-4 pr-1">
            {sections.map((sec) => (
              <div key={sec.key}>
                <div className="sticky top-0 z-10 bg-card/95 backdrop-blur text-xs font-medium text-primary/80 py-1">
                  {sec.title} <span className="text-muted-foreground">({sec.members.length})</span>
                </div>
                <ul className="divide-y">
                  {sec.members.map((p) => {
                    const k = keyOf(p)
                    const loading = busy === k
                    const isEditing = editing === k
                    const src = p.photo_url ? `${p.photo_url}${p.photo_url.includes("?") ? "&" : "?"}v=${p.id}` : ""
                    return (
                      <li key={k} className="py-2.5">
                        <div className="flex items-center gap-3">
                          {src ? (
                            <img src={src} alt="" className="size-12 shrink-0 rounded-full object-cover" />
                          ) : (
                            <span className="grid size-12 shrink-0 place-items-center rounded-full bg-primary/15 text-sm text-primary">
                              {initials(p.name)}
                            </span>
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">{p.name}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {[p.title, p.office].filter(Boolean).join(" · ") || "—"}
                            </span>
                          </span>
                          <input
                            ref={(el) => { fileInputs.current[k] = el }}
                            type="file"
                            accept="image/jpeg,image/png,image/gif,image/webp"
                            className="hidden"
                            onChange={(e) => {
                              const f = e.target.files?.[0]
                              if (f) upload(p, f)
                              e.target.value = ""
                            }}
                          />
                          <Button size="sm" variant="outline" disabled={loading} onClick={() => fileInputs.current[k]?.click()}>
                            {p.photo_url ? "Replace photo" : "Add photo"}
                          </Button>
                          {p.photo_url && (
                            <Button size="sm" variant="ghost" disabled={loading} onClick={() => removePhoto(p)}>
                              Remove photo
                            </Button>
                          )}
                          <Button size="sm" variant="outline" disabled={loading}
                            onClick={() => (isEditing ? (setEditing(null), setForm(null)) : startEdit(p))}>
                            {isEditing ? "Close" : "Edit"}
                          </Button>
                          <Button size="sm" variant="ghost" className="text-destructive" disabled={loading}
                            onClick={() => deletePerson(p)}>
                            Delete
                          </Button>
                        </div>

                        {isEditing && form && (
                          <div className="mt-2 ml-15 rounded-lg border bg-muted/30 p-3 space-y-2">
                            <div className="grid grid-cols-2 gap-2">
                              <Field label="Name" value={form.name} onChange={(v) => setForm((f) => f && { ...f, name: v })} />
                              <Field label="Title" value={form.title} onChange={(v) => setForm((f) => f && { ...f, title: v })} />
                              <Field label="Email" value={form.email} onChange={(v) => setForm((f) => f && { ...f, email: v })} />
                              <Field label="Office building" value={form.office_building} onChange={(v) => setForm((f) => f && { ...f, office_building: v })} />
                              <Field label="Office number" value={form.office_number} onChange={(v) => setForm((f) => f && { ...f, office_number: v })} />
                              {p.resource === "professors" && (
                                <Field label="Office hours" value={form.office_hours} onChange={(v) => setForm((f) => f && { ...f, office_hours: v })} />
                              )}
                            </div>
                            <div className="flex gap-2">
                              <Button size="sm" onClick={() => saveEdit(p)} disabled={loading || !form.name.trim()}>
                                {loading ? "Saving…" : "Save"}
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => { setEditing(null); setForm(null) }} disabled={loading}>
                                Cancel
                              </Button>
                            </div>
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
            {total === 0 && (
              <div className="py-2 text-sm text-muted-foreground">
                No directory people yet — add one above, or import campus data.
              </div>
            )}
          </div>
        </div>
      )}
    </PanelCard>
  )
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} className="h-8 text-sm" />
    </div>
  )
}
