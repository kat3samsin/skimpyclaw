<template>
  <div class="ascii-diagram">
    <pre><code>{{ diagram }}</code></pre>
    <span class="ascii-label">Text diagram</span>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  diagram: string
}>()
</script>

<style scoped>
.ascii-diagram {
  background: var(--vp-c-bg-alt);
  border: 1px solid var(--vp-c-border);
  border-radius: var(--vp-border-radius);
  padding: 16px;
  margin: 16px 0;
  overflow-x: auto;
}

.ascii-diagram pre {
  margin: 0;
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  line-height: 1.5;
  color: var(--vp-c-text-1);
}

.ascii-diagram code {
  background: none;
  padding: 0;
  color: inherit;
}

.ascii-label {
  display: block;
  margin-top: 8px;
  font-size: 11px;
  color: var(--vp-c-text-3);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
</style>
