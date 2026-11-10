import { lazy, Suspense, useEffect, useState } from 'react'
import { Link, Route, Routes, useLocation, useNavigate } from 'react-router'
import LoginScreen from './screens/LoginScreen.tsx'
import TicketsScreen from './screens/TicketsScreen.tsx'

const InfoScreen = lazy(() => import('./screens/InfoScreen.tsx'))

export default function App() {
  const [user, setUser] = useState<string | null | undefined>(undefined)
  const location = useLocation()
  const navigate = useNavigate()
  useEffect(() => {
    fetch('/api/me').then((r) => (r.ok ? r.json() : null)).then((me) => {
      setUser(me?.user ?? null)
      if (me === null && location.pathname !== '/login') navigate('/login')
    })
  }, [location.pathname])
  if (user === undefined) return <p>Lädt …</p>
  return (
    <>
      <header>
        {user !== null && <span data-testid="user-menu">{user}</span>}
        <nav aria-label="Hauptnavigation"><Link to="/">Tickets</Link> <Link to="/info">Info</Link></nav>
      </header>
      <main>
        <Suspense fallback={<p>Lädt …</p>}>
          <Routes>
            <Route path="/login" element={<LoginScreen onLogin={(name) => { setUser(name); navigate('/') }} />} />
            <Route path="/" element={<TicketsScreen />} />
            <Route path="/info" element={<InfoScreen />} />
          </Routes>
        </Suspense>
      </main>
    </>
  )
}
