import { createElement } from 'react'
import '../bewertung.ts'
import { useEffect, useState } from 'react'
import { explode } from '../explode.ts'

type Ticket = { nr: number; title: string }
const BUILD = import.meta.env.VITE_BUILD ?? 'dev'

export default function TicketsScreen() {
  const [tickets, setTickets] = useState<Ticket[] | null>(null)
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [status, setStatus] = useState('')
  const load = () => fetch('/api/tickets').then((r) => r.json()).then(setTickets)
  useEffect(() => { load() }, [])
  const create = async () => {
    const response = await fetch('/api/tickets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) })
    const ticket = await response.json()
    setOpen(false)
    setTitle('')
    setStatus(`Ticket #${ticket.nr} angelegt`)
    await load()
  }
  return (
    <section aria-label="Tickets">
      <h1>Tickets</h1>
      <p data-testid="build">Build: {BUILD}</p>
      <button onClick={() => setOpen(true)}>Neues Ticket</button>
      <button onClick={() => explode('Absichtlicher Fehler')}>Fehler auslösen</button>
      {status && <p role="status">{status}</p>}
      {tickets === null ? <p role="progressbar" aria-label="Tickets laden" /> : (
        <table aria-label="Ticketliste">
          <thead><tr><th>Nr</th><th>Titel</th></tr></thead>
          <tbody>{tickets.map((t) => <tr key={t.nr}><td>{t.nr}</td><td>{t.title}</td></tr>)}</tbody>
        </table>
      )}
      {open && (
        <div role="dialog" aria-modal="true" aria-label="Neues Ticket">
          <label htmlFor="title">Titel</label> <input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <button onClick={create}>Anlegen</button>
        </div>
      )}
      <section aria-label="Zahlung">
        <h2>Zahlung</h2>
        <iframe title="Zahlung" src="/embed.html" style={{ width: 360, height: 140, border: '1px solid #ccc' }} />
        {createElement('caw-bewertung')}
      </section>
    </section>
  )
}
