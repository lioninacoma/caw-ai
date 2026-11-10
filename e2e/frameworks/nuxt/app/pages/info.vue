<script setup lang="ts">
const BUILD = useRuntimeConfig().public.build
</script>

<template>
  <section aria-label="Info"><h1>Info</h1><p>Diese Seite wird nachgeladen.</p><p data-testid="build-info">Build: {{ BUILD }}</p></section>
</template>
