import { useEffect, useState } from "react"
import { api, type PendingChange, type AuditEntry } from "@/lib/api"
import { withStepUp } from "@/lib/webauthn"
import { useAuth } from "@/lib/auth"
import { Button } from "@/components/ui/button"
import { PanelCard } from "@/components/panels/PanelCard"
import { toast } from "sonner"

/** The approval queue. Center admins approve/reject pending changes; regular
 * admins see the status of their own submissions (read-only). */
export default function ApprovalsPanel({
  reloadKey,
  onApplied,
}: {
  reloadKey?: number
  onApplied?: () => void
}) {
  const { me } = useAuth()
  const isCenter = me?.role === "central_admin"
  const canSee = isCenter || me?.role === "admin"
  const [pending, setPending] = useState<PendingChange[]>([])
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [showAudit, setShowAudit] = useState(false)

  // Center admin sees the open queue; a requester sees their full history.
  const listPath = isCenter ? "/admin/pending" : "/admin/pending?status=all"

  async function load() {
    try {
      setPending(await api.get<PendingChange[]>(listPath))
      if (isCenter && showAudit) setAudit(await api.get<AuditEntry[]>("/admin/audit?limit=50"))
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    if (canSee) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey, canSee, showAudit])

  if (!canSee) return null

  async function decide(id: number, action: "approve" | "reject" | "review") {
    try {
      if (action === "reject") {
        const note = window.prompt("Reason for declining (optional):") ?? ""
        await withStepUp(() => api.post(`/admin/pending/${id}/reject`, { note }))
        toast.success("Declined")
      } else if (action === "review") {
        await withStepUp(() => api.post(`/admin/pending/${id}/review`))
        toast.success("Marked under review")
      } else {
        await withStepUp(() => api.post(`/admin/pending/${id}/approve`))
        toast.success("Approved & applied")
        onApplied?.() // refresh campus panels so the live data shows
      }
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed")
    }
  }

  const STATUS_LABEL: Record<string, string> = {
    pending: "Pending",
    under_review: "Under review",
    approved: "Approved",
    rejected: "Declined",
  }

  const title = isCenter ? "Approvals" : "My submissions"

  return (
    <PanelCard title={`${title}${pending.length ? ` (${pending.length})` : ""}`}>
      {!isCenter && (
        <div className="text-xs text-muted-foreground">
          Your changes wait here until a central admin approves them.
        </div>
      )}
      <ul className="mt-2 divide-y">
        {pending.map((pc) => (
          <li key={pc.id} className="py-2 text-sm">
            <div className="flex items-start gap-3">
              <div className="flex-1">
                <div className="font-medium">{pc.summary}</div>
                <div className="text-xs text-muted-foreground">
                  by {pc.proposer}
                  {pc.payload_summary &&
                    ` · ${pc.payload_summary.offerings} sections, ${pc.payload_summary.catalog} catalog`}
                  {" · "}
                  <span
                    className={
                      pc.status === "approved"
                        ? "text-emerald-400"
                        : pc.status === "rejected"
                          ? "text-red-400"
                          : pc.status === "under_review"
                            ? "text-amber-400"
                            : "text-muted-foreground"
                    }
                  >
                    {STATUS_LABEL[pc.status] ?? pc.status}
                  </span>
                </div>
              </div>
              {isCenter && (
                <div className="flex gap-1">
                  {pc.status === "pending" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={() => decide(pc.id, "review")}
                    >
                      Review
                    </Button>
                  )}
                  <Button size="sm" className="h-7 px-2" onClick={() => decide(pc.id, "approve")}>
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2"
                    onClick={() => decide(pc.id, "reject")}
                  >
                    Reject
                  </Button>
                </div>
              )}
            </div>
          </li>
        ))}
        {pending.length === 0 && (
          <li className="py-2 text-sm text-muted-foreground">Nothing waiting for approval.</li>
        )}
      </ul>

      {isCenter && (
        <div className="mt-3">
          <Button variant="outline" size="sm" onClick={() => setShowAudit((v) => !v)}>
            {showAudit ? "Hide" : "Show"} activity log
          </Button>
          {showAudit && (
            <ul className="mt-2 space-y-1 text-xs text-muted-foreground max-h-64 overflow-auto">
              {audit.map((a) => (
                <li key={a.id}>
                  <span className="text-foreground">{a.action}</span> · {a.summary} · {a.actor}
                </li>
              ))}
              {audit.length === 0 && <li>No activity yet.</li>}
            </ul>
          )}
        </div>
      )}
    </PanelCard>
  )
}
