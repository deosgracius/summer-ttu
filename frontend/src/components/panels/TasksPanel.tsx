import { useEffect, useState } from "react"
import { api, type Task } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { PanelCard } from "@/components/panels/PanelCard"

export default function TasksPanel({ reloadKey }: { reloadKey?: number }) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [title, setTitle] = useState("")

  async function load() {
    try {
      setTasks(await api.get<Task[]>("/tasks"))
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    load()
  }, [reloadKey])

  async function add() {
    if (!title.trim()) return
    await api.post("/tasks", { title })
    setTitle("")
    load()
  }
  async function toggle(t: Task) {
    await api.patch(`/tasks/${t.id}`, { done: !t.done })
    setTasks((prev) =>
      prev.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x)),
    )
  }
  async function remove(id: number) {
    await api.del(`/tasks/${id}`)
    load()
  }

  return (
    <PanelCard title="Tasks">
      <div className="flex gap-2">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="add a task"
        />
        <Button variant="secondary" onClick={add}>
          Add
        </Button>
      </div>
      <ul className="mt-3 divide-y">
        {tasks.map((t) => (
          <li key={t.id} className="flex items-center gap-3 py-2">
            <Checkbox checked={t.done} onCheckedChange={() => toggle(t)} />
            <span
              className={`flex-1 text-sm ${
                t.done ? "line-through text-muted-foreground" : ""
              }`}
            >
              {t.title}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => remove(t.id)}
            >
              ×
            </Button>
          </li>
        ))}
        {tasks.length === 0 && (
          <li className="py-2 text-sm text-muted-foreground">No tasks yet.</li>
        )}
      </ul>
    </PanelCard>
  )
}
