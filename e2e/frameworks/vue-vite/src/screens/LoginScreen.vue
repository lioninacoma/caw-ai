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
  if (!response.ok) { error.value = 'Sign-in failed'; return }
  const { user: name } = await response.json()
  user.value = name
  signedIn(name)
  router.push('/')
}
</script>

<template>
  <form aria-label="Login" @submit.prevent="submit">
    <label for="email">Email</label> <input id="email" v-model="email" type="email" />
    <label for="password">Password</label> <input id="password" v-model="password" type="password" />
    <button type="submit">Sign in</button>
    <p v-if="error" role="alert">{{ error }}</p>
  </form>
</template>
