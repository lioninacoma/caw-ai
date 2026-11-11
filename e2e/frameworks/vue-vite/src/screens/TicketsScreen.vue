<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { explode } from '../explode'

type Ticket = { id: number; title: string }
const BUILD = import.meta.env.VITE_BUILD ?? 'dev'
const tickets = ref<Ticket[] | null>(null)
const open = ref(false)
const title = ref('')
const status = ref('')
const load = async () => { tickets.value = await fetch('/api/tickets').then((r) => r.json()) }
onMounted(load)
async function create() {
  const ticket = await fetch('/api/tickets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: title.value }) }).then((r) => r.json())
  open.value = false
  title.value = ''
  status.value = `Ticket #${ticket.id} created`
  await load()
}
</script>

<template>
  <section aria-label="Tickets">
    <h1>Tickets</h1>
    <p data-testid="build">Build: {{ BUILD }}</p>
    <button @click="open = true">New ticket</button>
    <button @click="explode('Intentional error')">Trigger error</button>
    <p v-if="status" role="status">{{ status }}</p>
    <p v-if="tickets === null" role="progressbar" aria-label="Loading tickets"></p>
    <table v-else aria-label="Ticket list">
      <thead><tr><th>No.</th><th>Title</th></tr></thead>
      <tbody><tr v-for="t in tickets" :key="t.id"><td>{{ t.id }}</td><td>{{ t.title }}</td></tr></tbody>
    </table>
    <div v-if="open" role="dialog" aria-modal="true" aria-label="New ticket">
      <label for="title">Title</label> <input id="title" v-model="title" />
      <button @click="create">Create</button>
    </div>
  </section>
</template>
