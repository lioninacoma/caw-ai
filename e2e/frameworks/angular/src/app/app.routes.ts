import { inject } from '@angular/core';
import { CanActivateFn, Router, Routes } from '@angular/router';
import { LoginScreen } from './screens/login-screen';
import { TicketsScreen } from './screens/tickets-screen';
import { Session } from './session';

const signedIn: CanActivateFn = async () => (await inject(Session).check()) ? true : inject(Router).parseUrl('/login');

export const routes: Routes = [
  { path: 'login', component: LoginScreen },
  { path: '', component: TicketsScreen, canActivate: [signedIn] },
  { path: 'info', loadComponent: () => import('./screens/info-screen').then((m) => m.InfoScreen), canActivate: [signedIn] },
];
