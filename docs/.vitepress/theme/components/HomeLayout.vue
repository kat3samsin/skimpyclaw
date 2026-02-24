<script setup>
import DefaultTheme from 'vitepress/theme'
const { Layout } = DefaultTheme
</script>

<template>
  <Layout>
    <template #home-hero-after>
      <div class="hero-screenshot-wrapper">
        <div class="hero-screenshot-container">
          <img src="/dashboard-screenshot.png" alt="SkimpyClaw Dashboard" class="hero-screenshot" />
        </div>
      </div>
    </template>
  </Layout>
</template>

<style scoped>
.hero-screenshot-wrapper {
  background: linear-gradient(180deg, var(--vp-c-bg) 0%, var(--vp-c-bg) 180px, var(--vp-c-bg-soft) 180px, var(--vp-c-bg-soft) 100%);
}

.hero-screenshot-container {
  max-width: 1100px;
  margin: -20px auto 0;
  padding: 0 24px 64px;
  text-align: center;
}

.hero-screenshot {
  width: 100%;
  border-radius: 16px;
  border: 1px solid var(--vp-c-border);
  box-shadow: 0 12px 48px rgba(23, 16, 11, 0.12);
}
</style>
