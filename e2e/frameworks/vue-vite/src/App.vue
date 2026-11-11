<script setup lang="ts">
import { onMounted } from 'vue'
import { user } from './session'
onMounted(async () => {
  const me = await fetch('/api/me').then((r) => (r.ok ? r.json() : null))
  user.value = me?.user ?? null
})
</script>

<template>
  <header>
    <span v-if="user" data-testid="user-menu">{{ user }}</span>
    <nav aria-label="Main navigation"><RouterLink to="/">Tickets</RouterLink> <RouterLink to="/info">Info</RouterLink></nav>
  </header>
  <main><RouterView /></main>
</template>
