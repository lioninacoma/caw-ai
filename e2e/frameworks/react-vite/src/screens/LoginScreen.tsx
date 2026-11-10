import { useState, type FormEvent } from 'react'

export default function LoginScreen({ onLogin }: { onLogin: (user: string) => void }) {
  const [error, setError] = useState('')
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const response = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: data.get('email'), password: data.get('password') }) })
    if (response.ok) onLogin((await response.json()).user)
    else setError('Anmeldung fehlgeschlagen')
  }
  return (
    <form aria-label="Anmeldung" onSubmit={submit}>
      <label htmlFor="email">E-Mail</label> <input id="email" name="email" type="email" />
      <label htmlFor="password">Passwort</label> <input id="password" name="password" type="password" />
      <button type="submit">Anmelden</button>
      {error && <p role="alert">{error}</p>}
    </form>
  )
}
