<script setup lang="ts">
// Build id in the lazily loaded chunk too: the matrix uses it to check that lazy chunks come from the local build.
const BUILD = import.meta.env.VITE_BUILD ?? 'dev'
</script>

<template>
  <section aria-label="Info"><h1>Info</h1><p>This page is loaded lazily.</p><p data-testid="build-info">Build: {{ BUILD }}</p></section>
</template>
