import { StrictMode, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import RFB from '@novnc/novnc'
import './style.css'

interface Instance {
  id: string
  state: string
  variant: 'wry' | 'cef'
  display: string
  vncToken: string
  revision: { branch?: string; commit: string; dirtyFingerprint: string }
  endpoint?: { healthy: boolean }
  run?: {
    id: string
    suite: string
    step: number
    startedAt: string
    inputTokens: number
    outputTokens: number
    cost?: number
    failure?: string
    message?: string
  }
}

interface Snapshot { generatedAt: string; instances: Instance[] }

function useFleet(): Snapshot | undefined {
  const [fleet, setFleet] = useState<Snapshot>()
  useEffect(() => {
    let alive = true
    const update = async () => {
      try {
        const response = await fetch('/api/state', { cache: 'no-store' })
        if (alive && response.ok) setFleet(await response.json())
      } finally { if (alive) setTimeout(update, 1000) }
    }
    void update()
    return () => { alive = false }
  }, [])
  return fleet
}

function Vnc({ token }: { token: string }) {
  const screen = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!screen.current) return
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const rfb = new RFB(screen.current, `${protocol}//${location.host}/websockify?token=${encodeURIComponent(token)}`, { shared: true })
    rfb.viewOnly = true
    rfb.scaleViewport = true
    rfb.resizeSession = false
    return () => rfb.disconnect()
  }, [token])
  return <div className="screen" ref={screen} aria-label="Live application screen" />
}

function Tile({ instance }: { instance: Instance }) {
  const running = ['booting', 'ready', 'running'].includes(instance.state)
  const tokens = (instance.run?.inputTokens ?? 0) + (instance.run?.outputTokens ?? 0)
  const artifact = instance.run ? `/artifacts/${encodeURIComponent(instance.id)}/${encodeURIComponent(instance.run.id)}` : undefined
  return <article className={`tile ${instance.state}`}>
    <header>
      <div><strong>{instance.run?.suite ?? instance.id}</strong><small>{instance.revision.branch ?? instance.revision.commit.slice(0, 12)}</small></div>
      <span className="state">{instance.state}</span>
    </header>
    {running ? <Vnc token={instance.vncToken} /> : instance.run?.failure && artifact
      ? <a className="screen failure-shot" href={`${artifact}/failure.png`}><img src={`${artifact}/failure.png`} alt="Failure screenshot" /></a>
      : <div className="screen placeholder">No live screen</div>}
    <dl>
      <div><dt>Runtime</dt><dd>{instance.variant.toUpperCase()}</dd></div>
      <div><dt>Display</dt><dd>{instance.display}</dd></div>
      <div><dt>Agent</dt><dd>{instance.endpoint?.healthy ? 'healthy' : 'offline'}</dd></div>
      <div><dt>Step</dt><dd>{instance.run?.step ?? '—'}</dd></div>
      <div><dt>Tokens</dt><dd>{tokens.toLocaleString()}</dd></div>
      <div><dt>Cost</dt><dd>{instance.run?.cost === undefined ? '—' : `$${instance.run.cost.toFixed(4)}`}</dd></div>
    </dl>
    {instance.run?.message && <p className="message">{instance.run.failure}: {instance.run.message}</p>}
    {artifact && <nav><a href={`${artifact}/run.json`}>run</a><a href={`${artifact}/actions.jsonl`}>actions</a><a href={`${artifact}/replay.json`}>replay</a></nav>}
  </article>
}

function App() {
  const fleet = useFleet()
  const [grouped, setGrouped] = useState(false)
  const groups = useMemo(() => {
    const result = new Map<string, Instance[]>()
    for (const instance of fleet?.instances ?? []) {
      const key = `${instance.revision.branch ?? instance.revision.commit.slice(0, 12)} · ${instance.variant}`
      result.set(key, [...(result.get(key) ?? []), instance])
    }
    return result
  }, [fleet])
  return <main>
    <header className="topbar">
      <div><p className="eyebrow">TAURI AGENT</p><h1>Fleet</h1></div>
      <div className="toolbar"><span>{fleet?.instances.length ?? 0} instances</span><button onClick={() => setGrouped(!grouped)}>{grouped ? 'Grid view' : 'Group by revision'}</button></div>
    </header>
    {!fleet ? <p className="empty">Connecting to Fleet…</p> : fleet.instances.length === 0 ? <p className="empty">No instances. Start one with <code>tauri-agent-fleet up</code>.</p>
      : grouped ? <div className="groups">{[...groups].map(([name, instances]) => <section key={name}><h2>{name}</h2><div className="grid">{instances.map((item) => <Tile key={item.id} instance={item} />)}</div></section>)}</div>
      : <div className="grid">{fleet.instances.map((item) => <Tile key={item.id} instance={item} />)}</div>}
  </main>
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
