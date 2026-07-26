import type { ReactNode } from "react"
import { X } from "lucide-react"
import { cx } from "@/lib/utils/cx"
import { useCountUp } from "@/hooks/useCountUp"

export function LinkedinIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M20.45 20.45h-3.55v-5.57c0-1.33-.03-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.45v6.29zM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12zM7.12 20.45H3.56V9h3.56v11.45z" />
    </svg>
  )
}

export function Card({
  children,
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & { children: ReactNode; className?: string }) {
  return (
    <div className={cx("rounded-lg border border-line bg-card shadow-sm", className)} {...rest}>
      {children}
    </div>
  )
}

const badgeTones: Record<string, string> = {
  success: "bg-success/10 text-success",
  warn: "bg-warn/10 text-warn",
  danger: "bg-danger/10 text-danger",
  accent: "bg-accent/10 text-accent",
  sub: "bg-mutedbg text-sub",
}

export function Badge({ tone = "sub", children }: { tone?: string; children: ReactNode }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold",
        badgeTones[tone],
      )}
    >
      {children}
    </span>
  )
}

export function Dot({ tone }: { tone: "success" | "warn" | "danger" | "sub" }) {
  const c = { success: "bg-success", warn: "bg-warn", danger: "bg-danger", sub: "bg-sub" }[tone]
  return <span aria-hidden className={cx("inline-block h-2 w-2 rounded-full", c)} />
}

export function Button({
  variant = "primary",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" | "outline" }) {
  const styles = {
    primary:
      "bg-accent text-white hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed",
    outline: "border border-line bg-card text-fg hover:bg-mutedbg",
    ghost: "text-sub hover:bg-mutedbg hover:text-fg",
    danger: "bg-danger text-white hover:bg-danger/90",
  }[variant]
  return (
    <button
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-semibold transition-colors duration-150",
        styles,
        className,
      )}
      {...props}
    />
  )
}

export function StatCard({
  label,
  value,
  suffix = "",
  delta,
  icon,
}: {
  label: string
  value: number
  suffix?: string
  delta?: string
  icon: ReactNode
}) {
  const v = useCountUp(value)
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-sub">{label}</span>
        <span className="text-accent">{icon}</span>
      </div>
      <div className="tabular mt-2 text-3xl font-bold">
        {v.toLocaleString()}
        {suffix}
      </div>
      {delta && (
        <div className="mt-1 text-xs font-semibold text-success">{delta} vs last period</div>
      )}
    </Card>
  )
}

export function ProgressRing({ pct, label }: { pct: number; label: string }) {
  const r = 34
  const c = 2 * Math.PI * r
  return (
    <svg width="88" height="88" viewBox="0 0 88 88" role="img" aria-label={label}>
      <circle cx="44" cy="44" r={r} fill="none" stroke="var(--line)" strokeWidth="8" />
      <circle
        cx="44"
        cy="44"
        r={r}
        fill="none"
        stroke="#0369a1"
        strokeWidth="8"
        strokeLinecap="round"
        strokeDasharray={`${(pct / 100) * c} ${c}`}
        transform="rotate(-90 44 44)"
      />
      <text
        x="44"
        y="49"
        textAnchor="middle"
        className="tabular"
        fontSize="16"
        fontWeight="700"
        fill="currentColor"
      >
        {pct}%
      </text>
    </svg>
  )
}

export function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  const initials = name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-full bg-navy font-semibold text-white dark:bg-accent"
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      {initials}
    </span>
  )
}

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: ReactNode
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <Card className="w-full max-w-lg p-6" >
        <div onClick={(e) => e.stopPropagation()}>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xl font-bold">{title}</h2>
            <button aria-label="Close dialog" onClick={onClose} className="rounded-md p-1 text-sub hover:bg-mutedbg">
              <X size={18} />
            </button>
          </div>
          {children}
        </div>
      </Card>
    </div>
  )
}

export function EmptyState({ icon, title, hint, action }: { icon: ReactNode; title: string; hint: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 p-10 text-center">
      <span className="text-sub">{icon}</span>
      <p className="font-semibold">{title}</p>
      <p className="max-w-xs text-sm text-sub">{hint}</p>
      {action}
    </div>
  )
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string
  children: ReactNode
  hint?: string
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-semibold">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-sub">{hint}</span>}
    </label>
  )
}
