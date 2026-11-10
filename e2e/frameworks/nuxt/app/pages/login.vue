<script setup lang="ts">
const user = useState<string | null>('user')
const email = ref('')
const password = ref('')
const error = ref('')
async function submit() {
  const result = await $fetch<{ user: string }>('/api/login', { method: 'POST', body: { email: email.value, password: password.value } }).catch(() => null)
  if (result === null) { error.value = 'Anmeldung fehlgeschlagen'; return }
  user.value = result.user
  await navigateTo('/')
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
