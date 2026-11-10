<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { signedIn } from '../main'
import { user } from '../session'

const router = useRouter()
const email = ref('')
const password = ref('')
const error = ref('')
async function submit() {
  const response = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: email.value, password: password.value }) })
  if (!response.ok) { error.value = 'Anmeldung fehlgeschlagen'; return }
  const { user: name } = await response.json()
  user.value = name
  signedIn(name)
  router.push('/')
}
</script>

<template>
  <form aria-label="Anmeldung" @submit.prevent="submit">
    <label for="email">E-Mail</label> <input id="email" v-model="email" type="email" />
    <label for="password">Passwort</label> <input id="password" v-model="password" type="password" />
    <button type="submit">Anmelden</button>
    <p v-if="error" role="alert">{{ error }}</p>
  </form>
</template>
