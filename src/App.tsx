import { useEffect, useState } from "react"
import {
  BarChart3,
  Bell,
  Inbox as InboxIcon,
  LayoutDashboard,
  Loader2,
  LogOut,
  Mail,
  Menu,
  Moon,
  Plug,
  Rocket,
  Search,
  Send,
  UserPlus,
  Settings as SettingsIcon,
  Sun,
  UserCheck,
  Users,
  X,
} from "lucide-react"
import { api, auth } from "@/lib/api"
import type { LinkedInAccountState, Me } from "@/types"
import { Avatar, LinkedinIcon } from "@/components/ui"
import { ToastProvider } from "@/components/Toast"
import { cx } from "@/lib/utils/cx"
import { SHELL_POLL_INTERVAL_MS } from "@/constants"
import { Auth, Onboarding } from "./screens/AuthOnboarding"
import { Dashboard } from "./screens/Dashboard"
import { CampaignBuilder, CampaignDetail, CampaignList } from "./screens/Campaigns"
import { Inbox } from "./screens/Inbox"
import { Leads } from "./screens/Leads"
import { Analytics, Integrations, Sequences, Settings } from "./screens/Misc"
import { AutoSend } from "./screens/AutoSend"
import { Connections } from "./screens/Connections"
import type { CampaignRow as Campaign } from "@/types"

type NavKey =
  | "dashboard"
  | "campaigns"
  | "autoconnect"
  | "connections"
  | "automail"
  | "inbox"
  | "leads"
  | "sequences"
  | "analytics"
  | "integrations"
  | "settings"

const nav: { key: NavKey; label: string; icon: React.ReactNode }[] = [
  { key: "dashboard", label: "Dashboard", icon: <LayoutDashboard size={17} /> },
  { key: "campaigns", label: "Campaigns", icon: <Rocket size={17} /> },
  { key: "autoconnect", label: "Auto Connect", icon: <UserPlus size={17} /> },
  { key: "connections", label: "Connections", icon: <UserCheck size={17} /> },
  { key: "automail", label: "Auto Mail", icon: <Send size={17} /> },
  { key: "inbox", label: "Inbox", icon: <InboxIcon size={17} /> },
  { key: "leads", label: "Leads", icon: <Users size={17} /> },
  { key: "sequences", label: "Sequences", icon: <Mail size={17} /> },
  { key: "analytics", label: "Analytics", icon: <BarChart3 size={17} /> },
  { key: "integrations", label: "Integrations", icon: <Plug size={17} /> },
  { key: "settings", label: "Settings", icon: <SettingsIcon size={17} /> },
]

export default function App() {
  const [phase, setPhase] = useState<"loading" | "auth" | "onboarding" | "app">("loading")
  const [dark, setDark] = useState(false)
  const [view, setView] = useState<NavKey>("dashboard")
  const [campaignView, setCampaignView] = useState<"list" | "builder" | "detail">("list")
  const [activeCampaign, setActiveCampaign] = useState<Campaign | null>(null)
  const [mobileNav, setMobileNav] = useState(false)
  const [me, setMe] = useState<Me | null>(null)
  const [account, setAccount] = useState<LinkedInAccountState | null>(null)
  const [unread, setUnread] = useState(0)

  // Restore session on load: valid token → app/onboarding, else → auth.
  useEffect(() => {
    if (!auth.isAuthed()) {
      setPhase("auth")
      return
    }
    api
      .me()
      .then((m) => {
        setMe(m)
        setPhase(m.onboardingDone ? "app" : "onboarding")
      })
      .catch(() => {
        auth.clear()
        setPhase("auth")
      })
  }, [])

  // Once in the app, load the real account/warm-up state + unread notifications,
  // and refresh them periodically so the shell reflects live data.
  useEffect(() => {
    if (phase !== "app") return
    let alive = true
    const load = () => {
      api.linkedinAccount().then((a) => alive && setAccount(a)).catch(() => {})
      api
        .notifications()
        .then((ns) => alive && setUnread(ns.filter((n) => !n.read_at).length))
        .catch(() => {})
    }
    load()
    const t = setInterval(load, SHELL_POLL_INTERVAL_MS)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [phase])

  const logout = async () => {
    await api.logout()
    setView("dashboard")
    setPhase("auth")
  }

  // Real LinkedIn status pill for the header — reflects the actual account state.
  const accountBadge = (): { text: string; cls: string } | null => {
    if (!account) return null
    if (!account.connected) return { text: "LinkedIn not connected", cls: "border-line bg-mutedbg text-sub" }
    if (account.status === "checkpoint") return { text: "Action needed · verify LinkedIn", cls: "border-danger/40 bg-danger/10 text-danger" }
    if (account.status === "disconnected") return { text: "LinkedIn disconnected", cls: "border-danger/40 bg-danger/10 text-danger" }
    if (account.status === "paused") return { text: "LinkedIn paused", cls: "border-warn/40 bg-warn/10 text-warn" }
    if (!account.loggedIn) return { text: "Connecting…", cls: "border-warn/40 bg-warn/10 text-warn" }
    if (account.status === "warming_up" && account.warmup)
      return { text: `Connected · Warming up ${account.warmup.todayLimit}/day`, cls: "border-success/40 bg-success/10 text-success" }
    return { text: "Connected", cls: "border-success/40 bg-success/10 text-success" }
  }

  return (
    <div className={cx(dark && "dark")}>
      <div className="min-h-screen bg-bg text-fg">
        <ToastProvider>
          {phase === "loading" && (
            <div className="flex min-h-screen items-center justify-center">
              <Loader2 size={28} className="animate-spin text-accent" />
            </div>
          )}
          {phase === "auth" && <Auth onDone={() => setPhase("onboarding")} />}
          {phase === "onboarding" && <Onboarding onDone={() => setPhase("app")} />}
          {phase === "app" && (
            <div className="flex min-h-screen">
              {/* sidebar */}
              <aside
                className={cx(
                  "fixed inset-y-0 left-0 z-30 flex w-60 flex-col border-r border-line bg-card transition-transform lg:static lg:translate-x-0",
                  mobileNav ? "translate-x-0" : "-translate-x-full",
                )}
              >
                <div className="flex items-center justify-between px-5 py-5">
                  <span className="flex items-center gap-2 text-lg font-extrabold">
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-white">
                      <LinkedinIcon size={16} />
                    </span>
                    ReachPilot
                  </span>
                  <button className="text-sub lg:hidden" aria-label="Close menu" onClick={() => setMobileNav(false)}>
                    <X size={18} />
                  </button>
                </div>
                <nav className="flex flex-1 flex-col gap-1 px-3" aria-label="Main navigation">
                  {nav.map((n) => (
                    <button
                      key={n.key}
                      onClick={() => {
                        setView(n.key)
                        setCampaignView("list")
                        setMobileNav(false)
                      }}
                      aria-current={view === n.key ? "page" : undefined}
                      className={cx(
                        "flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-semibold transition-colors",
                        view === n.key
                          ? "bg-accent/10 text-accent"
                          : "text-sub hover:bg-mutedbg hover:text-fg",
                      )}
                    >
                      {n.icon}
                      {n.label}
                    </button>
                  ))}
                </nav>
                {account?.warmup ? (
                  <div className="m-3 rounded-lg bg-mutedbg p-3 text-xs">
                    <div className="mb-1 flex justify-between font-semibold">
                      <span>Warm-up</span>
                      <span className="tabular">
                        {account.warmup.todayLimit} / {account.warmup.target} per day
                      </span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-line">
                      <div
                        className="h-1.5 rounded-full bg-accent transition-all"
                        style={{ width: `${account.warmup.progressPct}%` }}
                      />
                    </div>
                    <p className="mt-1.5 text-sub">
                      {account.warmup.daysToFull > 0
                        ? `Full capacity in ~${account.warmup.daysToFull} days`
                        : "At full capacity"}
                    </p>
                  </div>
                ) : account && !account.connected ? (
                  <div className="m-3 rounded-lg bg-mutedbg p-3 text-xs text-sub">
                    No LinkedIn account connected yet.
                  </div>
                ) : null}
              </aside>
              {mobileNav && (
                <div className="fixed inset-0 z-20 bg-black/40 lg:hidden" onClick={() => setMobileNav(false)} />
              )}

              {/* main */}
              <div className="flex min-w-0 flex-1 flex-col">
                <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-card/90 px-4 py-3 backdrop-blur lg:px-6">
                  <button className="text-sub lg:hidden" aria-label="Open menu" onClick={() => setMobileNav(true)}>
                    <Menu size={20} />
                  </button>
                  <div className="relative hidden md:block">
                    <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-sub" />
                    <input
                      className="w-72 rounded-md border border-line bg-bg py-2 pl-9 pr-3 text-sm placeholder:text-sub"
                      placeholder="Search leads, campaigns…"
                      aria-label="Global search"
                    />
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    {(() => {
                      const b = accountBadge()
                      return b ? (
                        <span className={cx("hidden items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-bold sm:flex", b.cls)}>
                          <LinkedinIcon size={12} /> {b.text}
                        </span>
                      ) : null
                    })()}
                    <button
                      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
                      onClick={() => setDark(!dark)}
                      className="rounded-md p-2 text-sub hover:bg-mutedbg hover:text-fg"
                    >
                      {dark ? <Sun size={18} /> : <Moon size={18} />}
                    </button>
                    <button
                      aria-label={unread > 0 ? `Notifications — ${unread} unread` : "Notifications"}
                      className="relative rounded-md p-2 text-sub hover:bg-mutedbg hover:text-fg"
                    >
                      <Bell size={18} />
                      {unread > 0 && (
                        <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-danger text-[10px] font-bold text-white">
                          {unread > 9 ? "9+" : unread}
                        </span>
                      )}
                    </button>
                    <button
                      aria-label="Log out"
                      onClick={logout}
                      className="rounded-md p-2 text-sub hover:bg-mutedbg hover:text-fg"
                    >
                      <LogOut size={18} />
                    </button>
                    <Avatar name={me?.fullName || me?.email || "Account"} size={32} />
                  </div>
                </header>

                <main className="flex-1 p-4 lg:p-6">
                  {view === "dashboard" && <Dashboard />}
                  {view === "campaigns" && campaignView === "list" && (
                    <CampaignList
                      onOpen={(c) => {
                        setActiveCampaign(c)
                        setCampaignView("detail")
                      }}
                      onNew={() => setCampaignView("builder")}
                    />
                  )}
                  {view === "campaigns" && campaignView === "builder" && (
                    <CampaignBuilder onDone={() => setCampaignView("list")} />
                  )}
                  {view === "campaigns" && campaignView === "detail" && activeCampaign && (
                    <CampaignDetail campaign={activeCampaign} onBack={() => setCampaignView("list")} />
                  )}
                  {view === "autoconnect" && <AutoSend mode="linkedin" account={account} />}
                  {view === "connections" && <Connections />}
                  {view === "automail" && <AutoSend mode="email" account={account} />}
                  {view === "inbox" && <Inbox />}
                  {view === "leads" && <Leads />}
                  {view === "sequences" && <Sequences />}
                  {view === "analytics" && <Analytics />}
                  {view === "integrations" && <Integrations />}
                  {view === "settings" && <Settings />}
                </main>
              </div>
            </div>
          )}
        </ToastProvider>
      </div>
    </div>
  )
}
