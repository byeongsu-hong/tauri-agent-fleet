import { StrictMode, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { createRoot } from 'react-dom/client'
import RFB from '@novnc/novnc'
import './style.css'

type State = 'queued' | 'leased' | 'booting' | 'ready' | 'running' | 'passed' | 'failed' | 'stopped'
type Filter = 'all' | 'live' | 'queued' | 'running' | 'passed' | 'failed' | 'stopped'

interface Run {
  id: string
  suite: string
  objective: string
  progress: {
    step: number
    stepLimit: number
    elapsedMs: number
    timeLimitMs: number
    inputTokens: number
    outputTokens: number
    tokenLimit?: number
  }
  cost?: number
  failure?: { class: string; message: string }
  artifacts: Record<string, string>
}

interface Instance {
  id: string
  state: State
  runtime: 'wry' | 'cef'
  revision: { branch?: string; commit: string; dirty: boolean }
  display: string
  agent: { healthy: boolean }
  vnc: { available: boolean; websocket?: string }
  failure?: { class: string; message: string }
  run?: Run
  worker?: string
  remote?: boolean
}

interface Fleet {
  protocol: 'tauri-agent-console/v1'
  generatedAt: string
  summary: { total: number; live: number; running: number; passed: number; failed: number; tokens: number; cost: number }
  instances: Instance[]
}

const LIVE = new Set<State>(['leased', 'booting', 'ready', 'running'])

interface CoordinatorFleet {
  protocol: 'tauri-agent-coordinator/v1'
  generatedAt: string
  summary: { total: number; queued: number; active: number; passed: number; failed: number; inputTokens: number; outputTokens: number; cost: number }
  jobs: Array<{
    id: string; state: 'queued' | 'leased' | 'running' | 'passed' | 'failed'; workerId?: string; commit: string; runtime: 'wry' | 'cef'; attempt: number
    createdAt: string; updatedAt: string; suite: { id: string; objective: string; budget: { steps: number; seconds: number; tokens?: number } }
    failure?: { class: string; message: string }; run?: { inputTokens: number; outputTokens: number; cost?: number }; artifacts?: string[]
  }>
}

function normalize(value: Fleet | CoordinatorFleet): Fleet {
  if (value.protocol === 'tauri-agent-console/v1') return value
  const now = Date.parse(value.generatedAt)
  return {
    protocol: 'tauri-agent-console/v1', generatedAt: value.generatedAt,
    summary: {
      total: value.summary.total, live: value.summary.active, running: value.summary.active,
      passed: value.summary.passed, failed: value.summary.failed,
      tokens: value.summary.inputTokens + value.summary.outputTokens, cost: value.summary.cost
    },
    instances: value.jobs.map((job) => ({
      id: job.id, state: job.state, runtime: job.runtime, revision: { commit: job.commit, dirty: false },
      display: job.workerId ?? 'Unassigned', ...(job.workerId ? { worker: job.workerId } : {}), remote: true,
      agent: { healthy: job.state === 'leased' || job.state === 'running' }, vnc: { available: false },
      ...(job.failure ? { failure: job.failure } : {}),
      run: {
        id: job.id, suite: job.suite.id, objective: job.suite.objective,
        progress: {
          step: 0, stepLimit: job.suite.budget.steps,
          elapsedMs: Math.max(0, (job.state === 'passed' || job.state === 'failed' ? Date.parse(job.updatedAt) : now) - Date.parse(job.createdAt)),
          timeLimitMs: job.suite.budget.seconds * 1000,
          inputTokens: job.run?.inputTokens ?? 0, outputTokens: job.run?.outputTokens ?? 0,
          ...(job.suite.budget.tokens === undefined ? {} : { tokenLimit: job.suite.budget.tokens })
        },
        ...(job.run?.cost === undefined ? {} : { cost: job.run.cost }),
        ...(job.failure ? { failure: job.failure } : {}),
        artifacts: Object.fromEntries((job.artifacts ?? []).map((name) => [name === 'model-usage.jsonl' ? 'usage' : name === 'failure.png' ? 'screenshot' : name.replace(/\.(jsonl|json)$/, ''), `/api/v1/jobs/${encodeURIComponent(job.id)}/artifacts/${encodeURIComponent(name)}`]))
      }
    }))
  }
}

function useFleet(): { fleet: Fleet | undefined; error: string | undefined; authorizationRequired: boolean; setToken: (token: string) => void } {
  const [fleet, setFleet] = useState<Fleet>()
  const [error, setError] = useState<string>()
  const [authorizationRequired, setAuthorizationRequired] = useState(false)
  const [token, updateToken] = useState(() => sessionStorage.getItem('fleet-coordinator-token') ?? '')
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const update = async () => {
      try {
        const response = await fetch('/api/v1/fleet', { cache: 'no-store', signal: AbortSignal.timeout(5000), headers: token ? { authorization: `Bearer ${token}` } : {} })
        if (response.status === 401) setAuthorizationRequired(true)
        if (!response.ok) throw new Error(`Fleet returned ${response.status}`)
        const raw = await response.json() as Fleet | CoordinatorFleet
        if (raw.protocol !== 'tauri-agent-console/v1' && raw.protocol !== 'tauri-agent-coordinator/v1') throw new Error('Unsupported Fleet console protocol')
        if (alive) { setFleet(normalize(raw)); setError(undefined); setAuthorizationRequired(false) }
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : 'Fleet is unreachable')
      } finally {
        if (alive) timer = setTimeout(update, 1000)
      }
    }
    void update()
    return () => { alive = false; clearTimeout(timer) }
  }, [token])
  return {
    fleet, error, authorizationRequired,
    setToken(value) { sessionStorage.setItem('fleet-coordinator-token', value); updateToken(value) }
  }
}

function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

function compact(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value)
}

function Vnc({ path }: { path: string }) {
  const screen = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!screen.current) return
    const url = new URL(path, location.href)
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const rfb = new RFB(screen.current, url.toString(), { shared: true })
    rfb.viewOnly = true
    rfb.scaleViewport = true
    rfb.resizeSession = false
    return () => rfb.disconnect()
  }, [path])
  return <div className="vnc" ref={screen} role="img" aria-label="Live application screen" />
}

function Meter({ label, value, limit, display }: { label: string; value: number; limit?: number; display: string }) {
  const percent = limit ? Math.min(100, value / limit * 100) : 0
  return <div className="meter">
    <div className="meter-label"><span>{label}</span><strong>{display}</strong></div>
    <div className="meter-track" aria-label={`${label}: ${display}`} {...(limit ? { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuenow': Math.min(value, limit), 'aria-valuemax': limit } : {})}><i style={{ width: `${percent}%` }} /></div>
  </div>
}

function EmptyScreen({ state }: { state: State }) {
  const label = state === 'passed' ? 'Run complete' : state === 'failed' ? 'Run failed' : state === 'stopped' ? 'Instance stopped' : 'Screen unavailable'
  return <div className="vnc empty-screen">
    <svg viewBox="0 0 64 64" aria-hidden="true"><path d="M10 14h44v31H10zM22 54h20M32 45v9" /><path d="m25 26 6 5-6 5m10 0h7" /></svg>
    <span>{label}</span>
  </div>
}

function FailureScreen({ path }: { path: string }) {
  const [missing, setMissing] = useState(false)
  return missing ? <EmptyScreen state="failed" />
    : <a className="vnc failure-shot" href={path}><img src={path} onError={() => setMissing(true)} alt="Failure screenshot" /></a>
}

function Screen({ instance }: { instance: Instance }) {
  const failure = !instance.remote && instance.run?.failure && instance.run.artifacts.screenshot
  return <div className="screen-frame">
    {instance.vnc.available && instance.vnc.websocket
      ? <Vnc path={instance.vnc.websocket} />
      : failure
        ? <FailureScreen path={failure} />
        : <EmptyScreen state={instance.state} />}
    <div className="screen-meta">
      <span className="runtime">{instance.runtime}</span>
      <span>{instance.revision.branch ?? instance.revision.commit.slice(0, 10)}{instance.revision.dirty ? ' · dirty' : ''}</span>
    </div>
  </div>
}

function ArtifactLinks({ artifacts }: { artifacts: Record<string, string> }) {
  const visible = ['run', 'actions', 'usage', 'semantic', 'replay', 'console', 'network', 'ipc', 'screenshot']
  const open = async (event: MouseEvent<HTMLAnchorElement>, path: string) => {
    const token = sessionStorage.getItem('fleet-coordinator-token')
    if (!token) return
    event.preventDefault()
    const response = await fetch(path, { headers: { authorization: `Bearer ${token}` } })
    if (!response.ok) return
    const url = URL.createObjectURL(await response.blob())
    const link = document.createElement('a')
    link.href = url; link.download = path.split('/').pop() ?? 'artifact'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <nav className="artifacts" aria-label="Run artifacts">
    {visible.map((name) => artifacts[name] && <a key={name} href={artifacts[name]} onClick={(event) => void open(event, artifacts[name]!)}>{name}</a>)}
  </nav>
}

function InstanceCard({ instance }: { instance: Instance }) {
  const run = instance.run
  const tokens = (run?.progress.inputTokens ?? 0) + (run?.progress.outputTokens ?? 0)
  const title = run?.suite ?? instance.id
  const agent = instance.agent.healthy ? 'Connected' : LIVE.has(instance.state) ? 'Offline' : 'Ended'
  const failure = run?.failure ?? instance.failure
  return <article className={`instance-card state-${instance.state}`}>
    <header className="card-head">
      <div className="identity"><span aria-hidden="true" className={`health ${instance.agent.healthy ? 'online' : ''}`} /><div><h2>{title}</h2><p>{run ? instance.id : 'Interactive instance'}</p></div></div>
      <span className="state-pill">{instance.state}</span>
    </header>
    <Screen instance={instance} />
    <div className="card-body">
      {run && <p className="objective">{run.objective}</p>}
      {run ? <div className="meters">
        <Meter label="Steps" value={run.progress.step} limit={run.progress.stepLimit} display={`${run.progress.step}${run.progress.stepLimit ? ` / ${run.progress.stepLimit}` : ''}`} />
        <Meter label="Time" value={run.progress.elapsedMs} limit={run.progress.timeLimitMs} display={`${duration(run.progress.elapsedMs)} / ${duration(run.progress.timeLimitMs)}`} />
        <Meter label="Tokens" value={tokens} {...(run.progress.tokenLimit === undefined ? {} : { limit: run.progress.tokenLimit })} display={`${compact(tokens)}${run.progress.tokenLimit ? ` / ${compact(run.progress.tokenLimit)}` : ''}`} />
      </div> : <p className="objective muted">{instance.state === 'failed' ? 'Instance did not become ready.' : 'Ready for direct inspection and control through the application agent.'}</p>}
      <dl className="facts">
        <div><dt>Agent</dt><dd><span aria-hidden="true" className={`health ${instance.agent.healthy ? 'online' : ''}`} />{agent}</dd></div>
        <div><dt>{instance.remote ? 'Worker' : 'Display'}</dt><dd>{instance.display}</dd></div>
        <div><dt>Commit</dt><dd title={instance.revision.commit}>{instance.revision.commit.slice(0, 10)}</dd></div>
        <div><dt>Cost</dt><dd>{run?.cost === undefined ? '—' : `$${run.cost.toFixed(4)}`}</dd></div>
      </dl>
      {failure && <div className="failure"><strong>{failure.class.replace('_', ' ')}</strong><p>{failure.message}</p></div>}
    </div>
    {run && <ArtifactLinks artifacts={run.artifacts} />}
  </article>
}

function Metric({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return <div className={`metric ${tone ?? ''}`}><span>{label}</span><strong>{value}</strong></div>
}

function App() {
  const { fleet, error, authorizationRequired, setToken } = useFleet()
  const [token, setTokenInput] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [runtime, setRuntime] = useState<'all' | 'wry' | 'cef'>('all')
  const instances = useMemo(() => (fleet?.instances ?? []).filter((instance) => {
    const text = `${instance.id} ${instance.run?.suite ?? ''} ${instance.run?.objective ?? ''} ${instance.run?.failure?.class ?? instance.failure?.class ?? ''} ${instance.run?.failure?.message ?? instance.failure?.message ?? ''} ${instance.revision.branch ?? ''} ${instance.revision.commit} ${instance.revision.dirty ? 'dirty' : ''}`.toLowerCase()
    const stateMatch = filter === 'all' || (filter === 'live' ? LIVE.has(instance.state) : instance.state === filter)
    return text.includes(query.toLowerCase()) && stateMatch && (runtime === 'all' || instance.runtime === runtime)
  }), [fleet, query, filter, runtime])
  const syncAge = fleet ? Math.max(0, Date.now() - Date.parse(fleet.generatedAt)) : 0

  if (authorizationRequired && !fleet) return <main className="shell"><div className="empty-state">
    <h2>Coordinator authentication</h2><p>Enter the bearer token for this browser tab.</p>
    <form onSubmit={(event) => { event.preventDefault(); setToken(token) }}><input type="password" value={token} onChange={(event) => setTokenInput(event.target.value)} autoFocus /><button type="submit">Connect</button></form>
  </div></main>

  return <main className="shell">
    <header className="masthead">
      <a className="brand" href="/" aria-label="Tauri Agent Fleet home"><span className="brand-mark">F</span><span>TAURI AGENT <b>FLEET</b></span></a>
      <div className={`connection ${error ? 'disconnected' : ''}`} role="status" aria-live={error ? 'polite' : 'off'}><i aria-hidden="true" />{error ?? (fleet ? <>Live<span className="connection-age"> · {duration(syncAge)} ago</span></> : 'Connecting')}</div>
    </header>

    <section className="hero">
      <div><p className="kicker">OPERATIONS CONSOLE</p><h1>See every app.<br /><span>Miss nothing.</span></h1><p className="lede">Live runtime, deterministic runs, and failure evidence in one read-only workspace.</p></div>
      <div className="metrics" aria-label="Fleet summary">
        <Metric label="Live" value={fleet?.summary.live ?? '—'} tone="blue" />
        <Metric label="Running" value={fleet?.summary.running ?? '—'} tone="violet" />
        <Metric label="Passed" value={fleet?.summary.passed ?? '—'} tone="green" />
        <Metric label="Failed" value={fleet?.summary.failed ?? '—'} tone="red" />
        <Metric label="Tokens" value={fleet ? compact(fleet.summary.tokens) : '—'} />
        <Metric label="Cost" value={fleet ? `$${fleet.summary.cost.toFixed(4)}` : '—'} />
      </div>
    </section>

    <section className="controls" aria-label="Fleet filters">
      <label className="search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m16 16 5 5" /></svg><span className="sr-only">Search instances</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search suite, branch, instance…" /></label>
      <div className="filter-pills" role="group" aria-label="Filter by state">
        {(['all', 'live', 'queued', 'running', 'passed', 'failed', 'stopped'] as Filter[]).map((name) => <button key={name} aria-pressed={filter === name} className={filter === name ? 'selected' : ''} onClick={() => setFilter(name)}>{name}</button>)}
      </div>
      <label className="runtime-filter"><span>Runtime</span><select value={runtime} onChange={(event) => setRuntime(event.target.value as typeof runtime)}><option value="all">All</option><option value="wry">Wry</option><option value="cef">CEF</option></select></label>
    </section>

    <div className="section-title"><h2>Instances</h2><span>{instances.length} / {fleet?.summary.total ?? 0} shown</span></div>
    {!fleet ? <div className="empty-state"><span className="loader" /><h2>Connecting to Fleet</h2><p>Waiting for the local control plane.</p></div>
      : fleet.instances.length === 0 ? <div className="empty-state"><span className="empty-glyph">+</span><h2>No instances yet</h2><p>Start one with <code>tauri-agent-fleet up</code>.</p></div>
        : instances.length === 0 ? <div className="empty-state"><h2>No matching instances</h2><p>Clear a filter or try a broader search.</p></div>
          : <section className="instance-grid" aria-label="Fleet instances">{instances.map((instance) => <InstanceCard key={instance.id} instance={instance} />)}</section>}
  </main>
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
