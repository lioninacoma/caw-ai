import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZoneChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideProtractorTestingSupport } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';

import { routes } from './app.routes';

// Variante mit Zone.js und Testability, wie aeltere oder migrierte Anwendungen.
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideProtractorTestingSupport(),
    provideRouter(routes),
    provideHttpClient(),
  ],
};
