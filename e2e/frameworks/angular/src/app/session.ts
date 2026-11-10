import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class Session {
  readonly user = signal<string | null>(null);

  async check(): Promise<boolean> {
    if (this.user() !== null) return true;
    const me = await fetch('/api/me').then((r) => (r.ok ? r.json() : null));
    this.user.set(me?.user ?? null);
    return me !== null;
  }
}
