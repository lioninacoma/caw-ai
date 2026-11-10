<script setup lang="ts">
type Ticket = { nr: number; title: string }
const BUILD = useRuntimeConfig().public.build
const tickets = ref<Ticket[] | null>(null)
const open = ref(false)
const title = ref('')
const status = ref('')
const load = async () => { tickets.value = await $fetch<Ticket[]>('/api/tickets').catch(() => []) }
onMounted(load)
async function create() {
  const ticket = await $fetch<Ticket>('/api/tickets', { method: 'POST', body: { title: title.value } })
  open.value = false
  title.value = ''
  status.value = `Ticket #${ticket.nr} angelegt`
  await load()
}
</script>

<template>
  <section aria-label="Tickets">
    <h1>Tickets</h1>
    <p data-testid="build">Build: {{ BUILD }}</p>
    <button @click="open = true">Neues Ticket</button>
    <button @click="explode('Absichtlicher Fehler')">Fehler auslösen</button>
    <p v-if="status" role="status">{{ status }}</p>
    <p v-if="tickets === null" role="progressbar" aria-label="Tickets laden"></p>
    <table v-else aria-label="Ticketliste">
      <thead><tr><th>Nr</th><th>Titel</th></tr></thead>
      <tbody><tr v-for="t in tickets" :key="t.nr"><td>{{ t.nr }}</td><td>{{ t.title }}</td></tr></tbody>
    </table>
    <div v-if="open" role="dialog" aria-modal="true" aria-label="Neues Ticket">
      <label for="title">Titel</label> <input id="title" v-model="title" />
      <button @click="create">Anlegen</button>
    </div>
  </section>
</template>
