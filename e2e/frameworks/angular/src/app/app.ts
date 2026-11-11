import { Component, inject } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { Session } from './session';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink],
  template: `
    <header>
      @if (session.user(); as user) { <span data-testid="user-menu">{{ user }}</span> }
      <nav aria-label="Main navigation"><a routerLink="/">Tickets</a> <a routerLink="/info">Info</a></nav>
    </header>
    <main><router-outlet /></main>
  `,
})
export class App {
  protected readonly session = inject(Session);
}
