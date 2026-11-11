<script setup lang="ts">
const user = useState<string | null>('user')
const email = ref('')
const password = ref('')
const error = ref('')
async function submit() {
  const result = await $fetch<{ user: string }>('/api/login', { method: 'POST', body: { email: email.value, password: password.value } }).catch(() => null)
  if (result === null) { error.value = 'Sign-in failed'; return }
  user.value = result.user
  await navigateTo('/')
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
