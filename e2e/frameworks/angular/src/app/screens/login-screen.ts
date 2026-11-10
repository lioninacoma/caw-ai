import { Component, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { Session } from '../session';

@Component({
  selector: 'app-login-screen',
  template: `
    <form aria-label="Anmeldung" (submit)="submit($event)">
      <label for="email">E-Mail</label> <input id="email" name="email" type="email" />
      <label for="password">Passwort</label> <input id="password" name="password" type="password" />
      <button type="submit">Anmelden</button>
      @if (error()) { <p role="alert">{{ error() }}</p> }
    </form>
  `,
})
export class LoginScreen {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly session = inject(Session);
  protected readonly error = signal('');

  submit(event: Event) {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const field = (name: string) => (form.elements.namedItem(name) as HTMLInputElement).value;
    this.http.post<{ user: string }>('/api/login', { email: field('email'), password: field('password') }).subscribe({
      next: ({ user }) => { this.session.user.set(user); this.router.navigateByUrl('/'); },
      error: () => this.error.set('Anmeldung fehlgeschlagen'),
    });
  }
}
