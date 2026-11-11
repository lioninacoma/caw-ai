"use client";
import { useEffect, useState } from "react";
import { explode } from "./explode";

type Ticket = { id: number; title: string };
const BUILD = process.env.NEXT_PUBLIC_BUILD ?? "dev";

export default function TicketsScreen() {
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState("");
  const load = () => fetch("/api/tickets").then((r) => (r.ok ? r.json() : [])).then(setTickets);
  useEffect(() => { load(); }, []);
  const create = async () => {
    const ticket = await fetch("/api/tickets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) }).then((r) => r.json());
    setOpen(false);
    setTitle("");
    setStatus(`Ticket #${ticket.id} created`);
    await load();
  };
  return (
    <section aria-label="Tickets">
      <h1>Tickets</h1>
      <p data-testid="build">Build: {BUILD}</p>
      <button onClick={() => setOpen(true)}>New ticket</button>
      <button onClick={() => explode("Intentional error")}>Trigger error</button>
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
    </section>
  );
}
