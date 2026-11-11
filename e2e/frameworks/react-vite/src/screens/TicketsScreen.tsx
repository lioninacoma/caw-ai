import { createElement } from 'react'
import '../rating.ts'
import { useEffect, useState } from 'react'
import { explode } from '../explode.ts'

type Ticket = { id: number; title: string }
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
    setStatus(`Ticket #${ticket.id} created`)
    await load()
  }
  return (
    <section aria-label="Tickets">
      <h1>Tickets</h1>
      <p data-testid="build">Build: {BUILD}</p>
      <button onClick={() => setOpen(true)}>New ticket</button>
      <button onClick={() => explode('Intentional error')}>Trigger error</button>
      {status && <p role="status">{status}</p>}
      {tickets === null ? <p role="progressbar" aria-label="Loading tickets" /> : (
        <table aria-label="Ticket list">
          <thead><tr><th>No.</th><th>Title</th></tr></thead>
          <tbody>{tickets.map((t) => <tr key={t.id}><td>{t.id}</td><td>{t.title}</td></tr>)}</tbody>
        </table>
      )}
      {open && (
        <div role="dialog" aria-modal="true" aria-label="New ticket">
          <label htmlFor="title">Title</label> <input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <button onClick={create}>Create</button>
        </div>
      )}
      <section aria-label="Payment">
        <h2>Payment</h2>
        <iframe title="Payment" src="/embed.html" style={{ width: 360, height: 140, border: '1px solid #ccc' }} />
        {createElement('caw-rating')}
      </section>
    </section>
  )
}
