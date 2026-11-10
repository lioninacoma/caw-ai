<script setup lang="ts">
const user = useState<string | null>('user', () => null)
const route = useRoute()
onMounted(async () => {
  const me = await $fetch<{ user: string }>('/api/me').catch(() => null)
  user.value = me?.user ?? null
  if (me === null && route.path !== '/login') await navigateTo('/login')
})
</script>

<template>
  <header>
    <span v-if="user" data-testid="user-menu">{{ user }}</span>
    <nav aria-label="Hauptnavigation"><NuxtLink to="/">Tickets</NuxtLink> <NuxtLink to="/info">Info</NuxtLink></nav>
  </header>
  <main><NuxtPage /></main>
</template>
