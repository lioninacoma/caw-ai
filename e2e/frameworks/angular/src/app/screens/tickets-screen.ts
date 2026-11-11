import { Component, inject, OnInit, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { explode } from '../explode';

declare const CAW_BUILD: string | undefined;
type Ticket = { id: number; title: string };

@Component({
  selector: 'app-tickets-screen',
  template: `
    <section aria-label="Tickets">
      <h1>Tickets</h1>
      <p data-testid="build">Build: {{ build }}</p>
      <button (click)="open.set(true)">New ticket</button>
      <button (click)="fail()">Trigger error</button>
      @if (status()) { <p role="status">{{ status() }}</p> }
      @if (tickets(); as list) {
        <table aria-label="Ticket list">
          <thead><tr><th>No.</th><th>Title</th></tr></thead>
          <tbody>@for (t of list; track t.id) { <tr><td>{{ t.id }}</td><td>{{ t.title }}</td></tr> }</tbody>
        </table>
      } @else { <p role="progressbar" aria-label="Loading tickets"></p> }
      @if (open()) {
        <div role="dialog" aria-modal="true" aria-label="New ticket">
          <label for="title">Title</label> <input id="title" #title />
          <button (click)="create(title.value)">Create</button>
        </div>
      }
    </section>
  `,
})
export class TicketsScreen implements OnInit {
  private readonly http = inject(HttpClient);
  protected readonly build = typeof CAW_BUILD === 'string' ? CAW_BUILD : 'dev';
  protected readonly tickets = signal<Ticket[] | null>(null);
  protected readonly open = signal(false);
  protected readonly status = signal('');

  ngOnInit() { this.load(); }

  load() { this.http.get<Ticket[]>('/api/tickets').subscribe((list) => this.tickets.set(list)); }

  create(title: string) {
    this.http.post<Ticket>('/api/tickets', { title }).subscribe((ticket) => {
      this.open.set(false);
      this.status.set(`Ticket #${ticket.id} created`);
      this.load();
    });
  }

  fail() { explode('Intentional error'); }
}
