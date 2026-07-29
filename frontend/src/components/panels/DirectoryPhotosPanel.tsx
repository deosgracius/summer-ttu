import { useEffect, useRef, useState } from "react"
import { api, getToken } from "@/lib/api"
import { useAuth } from "@/lib/auth"
import { Button } from "@/components/ui/button"
import { PanelCard } from "@/components/panels/PanelCard"
import { toast } from "sonner"

// One directory person, as returned by GET /campus/directory-admin. `resource` is the
// backing table ("professors" | "staff"); `id` is that row's database id. Uploading a
// photo here sets photo_url on that exact row — the same row the kiosk sleep-screen reads.
interface DirPerson {
  resource: "professors" | "staff"
  id: number
  name: string
  title: string
  office: string
  photo_url: string
}
interface DirSection {
  key: string
  title: string
  members: DirPerson[]
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join("")
}

/**
 * Directory Photos — admin-only manager to upload, replace, or remove the headshot of any
 * professor / instructor / assistant professor / staff member. Changes flow to the kiosk
 * sleep-screen directory (which reads the same photo_url). Central admins apply instantly;
 * other admins submit the change for approval.
 */
export default function DirectoryPhotosPanel() {
  const { me } = useAuth()
  const isAdmin = me?.role === "admin" || me?.role === "central_admin"
  const [open, setOpen] = useState(false)
  const [sections, setSections] = useState<DirSection[]>([])
  const [busy, setBusy] = useState<string | null>(null) // "resource:id" currently uploading/removing
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({})

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
    // Client-side guard so an obvious mistake fails fast; the server re-validates by magic bytes.
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
      const out = await r.json()
      toast.success(out?.pending ? "Photo uploaded — submitted for approval" : "Photo updated")
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed")
    } finally {
      setBusy(null)
    }
  }

  async function remove(p: DirPerson) {
    const k = keyOf(p)
    setBusy(k)
    try {
      const out = await api.del<{ pending?: boolean }>(`/campus/${p.resource}/${p.id}/photo`)
      toast.success(out?.pending ? "Removal submitted for approval" : "Photo removed")
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't remove the photo")
    } finally {
      setBusy(null)
    }
  }

  const total = sections.reduce((n, s) => n + s.members.length, 0)

  return (
    <PanelCard title="Directory photos">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm hover:bg-muted/40"
      >
        <span>Upload, replace, or remove headshots shown on the kiosk sleep screen</span>
        <span className="text-muted-foreground">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-4">
          <p className="text-xs text-muted-foreground">
            Pick any person and choose an image (JPEG, PNG, GIF, or WebP, up to 6 MB). It's stored on
            Summer's own server and appears on the kiosk directory the next time it cycles.
            {me?.role !== "central_admin" && " Your changes are submitted for approval before they go live."}
          </p>

          <div className="max-h-[34rem] overflow-auto space-y-4 pr-1">
            {sections.map((sec) => (
              <div key={sec.key}>
                <div className="sticky top-0 z-10 bg-card/95 backdrop-blur text-xs font-medium text-primary/80 py-1">
                  {sec.title} <span className="text-muted-foreground">({sec.members.length})</span>
                </div>
                <ul className="divide-y">
                  {sec.members.map((p) => {
                    const k = keyOf(p)
                    const loading = busy === k
                    // Cache-bust so a just-replaced photo (which reuses no URL) never shows stale.
                    const src = p.photo_url ? `${p.photo_url}${p.photo_url.includes("?") ? "&" : "?"}v=${p.id}` : ""
                    return (
                      <li key={k} className="flex items-center gap-3 py-2.5">
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
                            e.target.value = "" // allow re-selecting the same file
                          }}
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={loading}
                          onClick={() => fileInputs.current[k]?.click()}
                        >
                          {loading ? "Working…" : p.photo_url ? "Replace" : "Upload"}
                        </Button>
                        {p.photo_url && (
                          <Button size="sm" variant="ghost" disabled={loading} onClick={() => remove(p)}>
                            Remove
                          </Button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
            {total === 0 && (
              <div className="py-2 text-sm text-muted-foreground">
                No directory people yet — import campus data first.
              </div>
            )}
          </div>
        </div>
      )}
    </PanelCard>
  )
}
