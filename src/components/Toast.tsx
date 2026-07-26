import { createContext, useContext, useState } from "react"
import type { ReactNode } from "react"
import { TOAST_DURATION_MS } from "@/constants"

type Toast = { id: number; text: string }

const ToastContext = createContext<(text: string) => void>(() => {})

/** Push a transient toast message from anywhere inside <ToastProvider>. */
export const useToast = () => useContext(ToastContext)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const push = (text: string) => {
    const id = Date.now()
    setToasts((current) => [...current, { id, text }])
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), TOAST_DURATION_MS)
  }
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div aria-live="polite" className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="toast-in flex items-center gap-3 rounded-lg bg-navy px-4 py-3 text-sm font-medium text-white shadow-lg dark:bg-accent"
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
