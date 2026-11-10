import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import LoginScreen from './screens/LoginScreen.vue'
import TicketsScreen from './screens/TicketsScreen.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: LoginScreen },
    { path: '/', component: TicketsScreen },
    { path: '/info', component: () => import('./screens/InfoScreen.vue') },
  ],
})
let me: string | null | undefined
router.beforeEach(async (to) => {
  if (me === undefined) me = await fetch('/api/me').then((r) => (r.ok ? r.json() : null)).then((x) => x?.user ?? null)
  if (me === null && to.path !== '/login') return '/login'
})
export const signedIn = (user: string) => { me = user }
createApp(App).use(router).mount('#app')
