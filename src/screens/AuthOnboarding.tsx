import { useEffect, useState } from "react"
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  ExternalLink,
  Globe,
  Info,
  Loader2,
  Lock,
  Mail,
  RefreshCcw,
  ShieldCheck,
  SlidersHorizontal,
  Star,
  Unplug,
  UploadCloud,
  AlertTriangle,
} from "lucide-react"
import { Button, Card, Field, LinkedinIcon, Modal } from "@/components/ui"
import { useToast } from "@/components/Toast"
import { cx } from "@/lib/utils/cx"
import { inputCls } from "@/constants"
import { api } from "@/lib/api"

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
    >
      <AlertTriangle size={15} className="mt-0.5 shrink-0" />
      {message}
    </div>
  )
}

function TrustPanel({ items, quote }: { items: { icon: React.ReactNode; title: string; sub: string }[]; quote?: string }) {
  return (
    <div className="hidden w-[380px] shrink-0 flex-col gap-4 lg:flex">
      <div className="flex h-44 items-center justify-center rounded-xl bg-gradient-to-br from-navy to-accent">
        <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white/15 text-white backdrop-blur">
          <LinkedinIcon size={32} />
        </span>
      </div>
      <Card className="divide-y divide-line">
        {items.map((it) => (
          <div key={it.title} className="flex items-start gap-3 p-3.5">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
              {it.icon}
            </span>
            <div>
              <p className="text-sm font-semibold">{it.title}</p>
              <p className="text-sm text-sub">{it.sub}</p>
            </div>
          </div>
        ))}
      </Card>
      {quote && (
        <Card className="p-4 text-sm text-sub">
          <div className="mb-1 flex gap-0.5 text-warn" aria-label="5 star rating">
            {[...Array(5)].map((_, i) => (
              <Star key={i} size={14} fill="currentColor" />
            ))}
          </div>
          "{quote}" <span className="font-semibold text-fg">— Olga M.</span>
        </Card>
      )}
    </div>
  )
}

export function Auth({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"login" | "signup">("signup")
  const [fullName, setFullName] = useState("")
  const [email, setEmail] = useState("")
  const [pw, setPw] = useState("")
  const [showPw, setShowPw] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const isSignup = mode === "signup"
  const canSubmit = !!email && pw.length >= 8 && (!isSignup || fullName.trim().length > 0)

  const submit = async () => {
    if (!canSubmit || busy) return
    setError("")
    setBusy(true)
    try {
      if (isSignup) await api.signup(email.trim(), pw, fullName.trim())
      else await api.login(email.trim(), pw)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen">
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2 text-xl font-extrabold">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-white">
              <LinkedinIcon size={16} />
            </span>
            ReachPilot
          </div>
          <h1 className="text-2xl font-bold">{isSignup ? "Create your account" : "Welcome back"}</h1>
          <p className="mb-6 text-sm text-sub">
            {isSignup ? "Start your outreach workspace in seconds." : "Log in to your outreach workspace."}
          </p>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              submit()
            }}
          >
            {isSignup && (
              <Field label="Full name">
                <input
                  className={inputCls}
                  autoComplete="name"
                  placeholder="Your full name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                />
              </Field>
            )}
            <Field label="Work email">
              <input
                className={inputCls}
                type="email"
                autoComplete="email"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Password" hint={isSignup ? "At least 8 characters." : undefined}>
              <div className="relative">
                <input
                  className={inputCls}
                  type={showPw ? "text" : "password"}
                  autoComplete={isSignup ? "new-password" : "current-password"}
                  placeholder="Your password"
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                />
                <button
                  type="button"
                  aria-label={showPw ? "Hide password" : "Show password"}
                  onClick={() => setShowPw(!showPw)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-sub hover:text-fg"
                >
                  {showPw ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
            </Field>
            {error && <ErrorBanner message={error} />}
            <Button type="submit" disabled={!canSubmit || busy}>
              {busy ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <>
                  {isSignup ? "Create account" : "Log in"} <ArrowRight size={16} />
                </>
              )}
            </Button>
          </form>
          <p className="mt-5 text-center text-sm text-sub">
            {isSignup ? "Already have an account?" : "New to ReachPilot?"}{" "}
            <button
              className="font-semibold text-accent hover:underline"
              onClick={() => {
                setMode(isSignup ? "login" : "signup")
                setError("")
              }}
            >
              {isSignup ? "Log in" : "Create one"}
            </button>
          </p>
        </div>
      </div>
      <div className="hidden flex-1 items-center justify-center bg-navy p-10 text-white lg:flex">
        <div className="max-w-md">
          <div className="mb-2 flex gap-0.5 text-warn" aria-label="5 star rating">
            {[...Array(5)].map((_, i) => (
              <Star key={i} size={16} fill="currentColor" />
            ))}
          </div>
          <p className="text-xl font-semibold leading-relaxed">
            "We booked 34 meetings in our first month. ReachPilot's warm-up kept every account
            safe."
          </p>
          <p className="mt-3 text-sm text-white/70">Dana K. — Head of Growth, Fjord Labs</p>
          <div className="mt-8 flex items-center gap-4 text-xs font-semibold text-white/60">
            <span className="rounded border border-white/20 px-2 py-1">SOC 2 Type II</span>
            <span className="rounded border border-white/20 px-2 py-1">GDPR ready</span>
            <span className="rounded border border-white/20 px-2 py-1">4.7 ★ on G2</span>
          </div>
        </div>
      </div>
    </div>
  )
}

const steps = ["Workspace", "LinkedIn", "2FA", "Gmail", "Warm-up", "Leads"]

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0)
  const [showPw, setShowPw] = useState(false)
  const [wsName, setWsName] = useState("")
  const [wsGoal, setWsGoal] = useState("Sales")
  const [liEmail, setLiEmail] = useState("")
  const [liPw, setLiPw] = useState("")
  const [country, setCountry] = useState("")
  const [secret, setSecret] = useState("")
  const [gmailConnected, setGmailConnected] = useState(false)
  const [emailLimit, setEmailLimit] = useState(50)
  const [hoursStart, setHoursStart] = useState("09:00")
  const [hoursEnd, setHoursEnd] = useState("18:00")
  const [leadSource, setLeadSource] = useState("")
  const [leadUrl, setLeadUrl] = useState("")
  const [skipModal, setSkipModal] = useState(false)
  const [limit, setLimit] = useState(10)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const toast = useToast()

  // Resume from saved backend progress on mount.
  useEffect(() => {
    api
      .getOnboarding()
      .then((s) => {
        if (s.onboardingDone) {
          onDone()
          return
        }
        if (s.workspace) {
          setWsName(s.workspace.name)
          setWsGoal(s.workspace.goal)
        }
        if (s.linkedin) {
          setLiEmail(s.linkedin.email)
          setCountry(s.linkedin.country)
        }
        if (s.gmail) {
          setGmailConnected(true)
          setEmailLimit(s.gmail.dailyLimit)
        }
        if (s.warmup) {
          setLimit(s.warmup.dailyLimit)
          setHoursStart(s.warmup.hoursStart)
          setHoursEnd(s.warmup.hoursEnd)
        }
        if (s.leadSource) setLeadSource(s.leadSource)
        // Jump to the first unfinished step.
        setStep(Math.min(s.completedStep, steps.length - 1))
      })
      .catch(() => {
        /* server offline — start fresh at step 0 */
      })
  }, [onDone])

  // Go back one step, clearing any inline error from the current step.
  const back = () => {
    setError("")
    setStep((s) => Math.max(0, s - 1))
  }

  // Runs an async step action, shows loading + inline errors, advances on success.
  const run = async (fn: () => Promise<unknown>, advance = true) => {
    setBusy(true)
    setError("")
    try {
      await fn()
      if (advance) {
        if (step === steps.length - 1) {
          const res = await api.complete()
          toast(res.message)
          onDone()
        } else {
          setStep(step + 1)
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between px-8 py-5">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 font-extrabold">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-white">
              <LinkedinIcon size={14} />
            </span>
            ReachPilot
          </div>
          {step > 0 && (
            <button
              className="flex items-center gap-1 text-sm font-semibold text-sub hover:text-fg"
              onClick={back}
              disabled={busy}
            >
              <ArrowLeft size={16} /> Back
            </button>
          )}
        </div>
        <div className="flex items-center gap-3 text-sm font-semibold text-sub">
          Step {step + 1} of {steps.length}
          <div className="flex gap-1.5" aria-hidden>
            {steps.map((_, i) => (
              <span
                key={i}
                className={cx(
                  "h-2 rounded-full transition-all duration-300",
                  i === step ? "w-6 bg-accent" : "w-2 bg-line",
                  i < step && "bg-accent/50",
                )}
              />
            ))}
          </div>
        </div>
        <button className="text-sm font-semibold text-sub hover:text-fg" onClick={onDone}>
          Skip setup
        </button>
      </header>

      <div className="mx-auto flex max-w-5xl gap-12 px-8 py-8">
        <div className="max-w-md flex-1">
          {step === 0 && (
            <div className="flex flex-col gap-5">
              <h1 className="text-3xl font-bold">Create your workspace</h1>
              <Field label="Workspace name">
                <input
                  className={inputCls}
                  placeholder="Acme Outbound"
                  value={wsName}
                  onChange={(e) => setWsName(e.target.value)}
                />
              </Field>
              <Field label="Primary goal">
                <select
                  className={inputCls}
                  value={wsGoal}
                  onChange={(e) => setWsGoal(e.target.value)}
                >
                  <option>Sales</option>
                  <option>Recruiting</option>
                  <option>Agency</option>
                </select>
              </Field>
              {error && <ErrorBanner message={error} />}
              <Button
                disabled={busy || !wsName.trim()}
                onClick={() => run(() => api.saveWorkspace(wsName, wsGoal))}
              >
                {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
                Continue
              </Button>
            </div>
          )}

          {step === 1 && (
            <div className="flex flex-col gap-5">
              <div>
                <h1 className="text-3xl font-bold">Connect your LinkedIn account</h1>
                <p className="mt-2 text-sub">
                  We'll route activity through a dedicated IP that matches where you usually log
                  in.
                </p>
              </div>
              <Field label="LinkedIn email">
                <input
                  className={inputCls}
                  type="email"
                  placeholder="you@company.com"
                  value={liEmail}
                  onChange={(e) => setLiEmail(e.target.value)}
                />
              </Field>
              <Field label="LinkedIn password">
                <div className="relative">
                  <input
                    className={inputCls}
                    type={showPw ? "text" : "password"}
                    placeholder="Your LinkedIn password"
                    value={liPw}
                    onChange={(e) => setLiPw(e.target.value)}
                  />
                  <button
                    type="button"
                    aria-label={showPw ? "Hide password" : "Show password"}
                    onClick={() => setShowPw(!showPw)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-sub hover:text-fg"
                  >
                    {showPw ? <EyeOff size={17} /> : <Eye size={17} />}
                  </button>
                </div>
              </Field>
              <Field
                label="Country"
                hint="We'll set up a dedicated IP here so LinkedIn sees consistent activity."
              >
                <select
                  className={inputCls}
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                >
                  <option value="">Select a country</option>
                  <option>India</option>
                  <option>United States</option>
                  <option>Germany</option>
                </select>
              </Field>
              {error && <ErrorBanner message={error} />}
              <Button
                disabled={busy || !liEmail || !liPw || !country}
                onClick={() =>
                  run(() => api.connectLinkedin(liEmail, liPw, country))
                }
              >
                {busy ? (
                  <>
                    <Loader2 size={16} className="animate-spin" /> Connecting &amp; provisioning IP…
                  </>
                ) : (
                  "Connect LinkedIn"
                )}
              </Button>
            </div>
          )}

          {step === 2 && (
            <div className="flex flex-col gap-6">
              <div>
                <h1 className="text-3xl font-bold">Protect this LinkedIn account</h1>
                <p className="mt-2 text-sub">Stops LinkedIn from flagging this account on new IPs.</p>
              </div>
              <ol className="flex flex-col gap-6 border-l border-line pl-6">
                <li className="relative">
                  <span className="absolute -left-[34px] flex h-6 w-6 items-center justify-center rounded-full bg-mutedbg text-xs font-bold">
                    1
                  </span>
                  <p className="font-semibold">Set up 2FA on LinkedIn</p>
                  <p className="text-sm text-sub">
                    Pick Authenticator app, scan the QR with your authenticator.
                  </p>
                  <div className="mt-2 flex items-start gap-2 rounded-md bg-mutedbg px-3 py-2 text-sm">
                    <Info size={15} className="mt-0.5 shrink-0 text-sub" />
                    Already have 2FA? Disable it first, then re-enable.
                  </div>
                  <Button variant="outline" className="mt-3">
                    Open LinkedIn 2FA settings <ExternalLink size={15} />
                  </Button>
                </li>
                <li className="relative">
                  <span className="absolute -left-[34px] flex h-6 w-6 items-center justify-center rounded-full bg-mutedbg text-xs font-bold">
                    2
                  </span>
                  <p className="font-semibold">Paste &amp; verify the secret key</p>
                  <div className="mt-2 flex gap-2">
                    <input
                      className={inputCls}
                      placeholder="JBSWY3DPEHPK3PXP…"
                      value={secret}
                      onChange={(e) => setSecret(e.target.value)}
                    />
                  </div>
                </li>
                <li className="relative">
                  <span className="absolute -left-[34px] flex h-6 w-6 items-center justify-center rounded-full bg-mutedbg text-xs font-bold">
                    3
                  </span>
                  <p className="font-semibold">Confirm on LinkedIn</p>
                  <p className="text-sm text-sub">
                    Enter the code from your authenticator in LinkedIn to finish.
                  </p>
                </li>
              </ol>
              {error && <ErrorBanner message={error} />}
              <div className="flex items-center justify-between">
                <button
                  className="text-sm font-semibold text-sub hover:text-fg"
                  onClick={() => setSkipModal(true)}
                >
                  Skip — risk disconnects
                </button>
                <Button disabled={busy} onClick={() => run(() => api.verify2fa(secret))}>
                  {busy ? (
                    <>
                      <Loader2 size={16} className="animate-spin" /> Verifying…
                    </>
                  ) : (
                    <>
                      I've finished on LinkedIn <ArrowRight size={16} />
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="flex flex-col gap-5">
              <h1 className="text-3xl font-bold">Connect Gmail</h1>
              <p className="text-sub">Send email steps and follow-ups from your own inbox.</p>
              <Card className="flex items-center gap-3 p-4">
                <Mail className="text-danger" />
                <div className="flex-1">
                  <p className="font-semibold">Google Workspace</p>
                  <p className="text-sm text-sub">OAuth — we never store your password</p>
                </div>
                {gmailConnected ? (
                  <span className="flex items-center gap-1 text-sm font-semibold text-success">
                    <CheckCircle2 size={16} /> Connected
                  </span>
                ) : (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        await api.connectGmail(emailLimit)
                        setGmailConnected(true)
                      }, false)
                    }
                  >
                    {busy ? <Loader2 size={16} className="animate-spin" /> : "Connect"}
                  </Button>
                )}
              </Card>
              <Field label={`Daily sending limit — ${emailLimit}/day`}>
                <input
                  type="range"
                  min={20}
                  max={150}
                  value={emailLimit}
                  onChange={(e) => setEmailLimit(Number(e.target.value))}
                  className="w-full accent-[#0369a1]"
                />
              </Field>
              {error && <ErrorBanner message={error} />}
              <Button
                disabled={busy || !gmailConnected}
                onClick={() => run(() => api.connectGmail(emailLimit))}
              >
                Continue <ArrowRight size={16} />
              </Button>
            </div>
          )}

          {step === 4 && (
            <div className="flex flex-col gap-5">
              <h1 className="text-3xl font-bold">Warm-up preferences</h1>
              <p className="text-sub">
                Start slow, ramp up automatically. Keeps your account looking natural.
              </p>
              <Field label={`Daily connection requests — start at ${limit}/day`}>
                <input
                  type="range"
                  min={5}
                  max={45}
                  value={limit}
                  onChange={(e) => setLimit(Number(e.target.value))}
                  className="w-full accent-[#0369a1]"
                />
                <span className="mt-1 block text-xs text-sub">
                  Recommended: 10 → ramps to 45/day over 3 weeks
                </span>
              </Field>
              {limit > 30 && (
                <div className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
                  <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                  Starting above 30/day increases restriction risk on fresh accounts.
                </div>
              )}
              <Field label="Working hours">
                <div className="flex items-center gap-2">
                  <input
                    className={inputCls}
                    value={hoursStart}
                    onChange={(e) => setHoursStart(e.target.value)}
                  />
                  <span className="text-sub">to</span>
                  <input
                    className={inputCls}
                    value={hoursEnd}
                    onChange={(e) => setHoursEnd(e.target.value)}
                  />
                </div>
              </Field>
              {error && <ErrorBanner message={error} />}
              <Button
                disabled={busy}
                onClick={() =>
                  run(() =>
                    api.saveWarmup({
                      dailyLimit: limit,
                      hoursStart,
                      hoursEnd,
                      weekends: false,
                    }),
                  )
                }
              >
                {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
                Continue
              </Button>
            </div>
          )}

          {step === 5 && (
            <div className="flex flex-col gap-5">
              <h1 className="text-3xl font-bold">Import your first leads</h1>
              {[
                { id: "linkedin", icon: <LinkedinIcon size={18} />, t: "LinkedIn search URL", s: "Paste any people-search link" },
                { id: "salesnav", icon: <SlidersHorizontal size={18} />, t: "Sales Navigator URL", s: "Best filters, best data" },
                { id: "csv", icon: <UploadCloud size={18} />, t: "Upload CSV", s: "Map your own columns" },
              ].map((o) => (
                <Card
                  key={o.id}
                  role="button"
                  tabIndex={0}
                  aria-pressed={leadSource === o.id}
                  onClick={() => setLeadSource(o.id)}
                  onKeyDown={(e) => e.key === "Enter" && setLeadSource(o.id)}
                  className={cx(
                    "flex cursor-pointer items-center gap-3 p-4 transition-colors hover:border-accent",
                    leadSource === o.id && "border-accent ring-1 ring-accent",
                  )}
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-md bg-accent/10 text-accent">
                    {o.icon}
                  </span>
                  <div className="flex-1">
                    <p className="font-semibold">{o.t}</p>
                    <p className="text-sm text-sub">{o.s}</p>
                  </div>
                  {leadSource === o.id && <CheckCircle2 size={18} className="text-accent" />}
                </Card>
              ))}
              {(leadSource === "linkedin" || leadSource === "salesnav") && (
                <Field label="Search URL">
                  <input
                    className={inputCls}
                    placeholder="https://www.linkedin.com/search/results/people/…"
                    value={leadUrl}
                    onChange={(e) => setLeadUrl(e.target.value)}
                  />
                </Field>
              )}
              {error && <ErrorBanner message={error} />}
              <Button
                disabled={busy || !leadSource}
                onClick={() =>
                  run(async () => {
                    await api.importLeads({
                      source: leadSource,
                      url: leadUrl,
                      rows: leadSource === "csv" ? [{ name: "Sample Lead" }] : undefined,
                    })
                  })
                }
              >
                {busy ? (
                  <>
                    <Loader2 size={16} className="animate-spin" /> Finishing setup…
                  </>
                ) : (
                  <>
                    Finish setup <CheckCircle2 size={16} />
                  </>
                )}
              </Button>
            </div>
          )}
        </div>

        {step === 1 && (
          <TrustPanel
            quote="I love the fact that it's safe, so I don't have to worry about our accounts getting banned."
            items={[
              { icon: <Lock size={16} />, title: "Your credentials are encrypted", sub: "Encrypted and securely stored. Never shared or visible." },
              { icon: <Globe size={16} />, title: "Dedicated IP per account", sub: "A country-locked IP, just for this account. Never reused." },
              { icon: <SlidersHorizontal size={16} />, title: "You're always in control", sub: "Nothing is sent without a campaign you approved." },
              { icon: <RefreshCcw size={16} />, title: "Gradual account warm-up", sub: "Activity ramps up slowly to keep it looking natural." },
              { icon: <Unplug size={16} />, title: "Disconnect in one click", sub: "Access ends the moment you remove the account." },
            ]}
          />
        )}
        {step === 2 && (
          <TrustPanel
            items={[
              { icon: <RefreshCcw size={16} />, title: "No reconnecting later", sub: "Your account stays connected on its own." },
              { icon: <ShieldCheck size={16} />, title: "Your campaigns keep running", sub: "ReachPilot enters the PIN whenever LinkedIn asks." },
              { icon: <Star size={16} />, title: "Sales Nav & Recruiter", sub: "2FA setup is required to utilize your subscriptions." },
            ]}
          />
        )}
      </div>

      {skipModal && (
        <Modal title="Skip 2FA setup?" onClose={() => setSkipModal(false)}>
          <p className="mb-4 text-sm text-sub">Without 2FA on this LinkedIn account:</p>
          <div className="flex flex-col gap-3">
            <div className="rounded-lg border border-warn/40 bg-warn/10 p-4">
              <p className="flex items-center gap-2 font-semibold text-warn">
                <Unplug size={16} /> It'll disconnect more often.
              </p>
              <p className="mt-1 text-sm">
                LinkedIn challenges new IPs more aggressively when 2FA isn't on. Expect more
                reconnects mid-campaign.
              </p>
            </div>
            <div className="rounded-lg border border-warn/40 bg-warn/10 p-4">
              <p className="flex items-center gap-2 font-semibold text-warn">
                <AlertTriangle size={16} /> Sales Navigator and Recruiter won't work.
              </p>
              <p className="mt-1 text-sm">
                LinkedIn requires 2FA for its premium products. If you use either, set up 2FA now.
              </p>
            </div>
          </div>
          <div className="mt-5 flex justify-end gap-3">
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api.skip2fa()
                  setSkipModal(false)
                }, false).then(() => setStep(3))
              }
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : "Skip anyway"}
            </Button>
            <Button onClick={() => setSkipModal(false)}>Set up 2FA</Button>
          </div>
        </Modal>
      )}
    </div>
  )
}
