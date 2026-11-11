import { Component } from '@angular/core';

declare const CAW_BUILD: string | undefined;

// Build id in the lazily loaded chunk too: the matrix uses it to check that lazy chunks come from the local build.
@Component({
  selector: 'app-info-screen',
  template: `<section aria-label="Info"><h1>Info</h1><p>This page is loaded lazily.</p><p data-testid="build-info">Build: {{ build }}</p></section>`,
})
export class InfoScreen {
  protected readonly build = typeof CAW_BUILD === 'string' ? CAW_BUILD : 'dev';
}
