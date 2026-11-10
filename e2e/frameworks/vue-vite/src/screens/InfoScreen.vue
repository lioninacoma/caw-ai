<script setup lang="ts">
// Build-Kennung auch im nachgeladenen Chunk: Die Matrix prueft damit, dass lazy Chunks aus dem lokalen Build kommen.
const BUILD = import.meta.env.VITE_BUILD ?? 'dev'
</script>

<template>
  <section aria-label="Info"><h1>Info</h1><p>Diese Seite wird nachgeladen.</p><p data-testid="build-info">Build: {{ BUILD }}</p></section>
</template>
