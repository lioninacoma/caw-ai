import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZoneChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideProtractorTestingSupport } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';

import { routes } from './app.routes';

// Variant with Zone.js and Testability, like older or migrated applications.
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideProtractorTestingSupport(),
    provideRouter(routes),
    provideHttpClient(),
  ],
};
