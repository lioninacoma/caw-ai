import { Component } from '@angular/core';

declare const CAW_BUILD: string | undefined;

// Build-Kennung auch im nachgeladenen Chunk: Die Matrix prueft damit, dass lazy Chunks aus dem lokalen Build kommen.
@Component({
  selector: 'app-info-screen',
  template: `<section aria-label="Info"><h1>Info</h1><p>Diese Seite wird nachgeladen.</p><p data-testid="build-info">Build: {{ build }}</p></section>`,
})
export class InfoScreen {
  protected readonly build = typeof CAW_BUILD === 'string' ? CAW_BUILD : 'dev';
}
