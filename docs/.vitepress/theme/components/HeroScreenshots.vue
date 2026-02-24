<template>
  <div class="hero-screenshots">
    <img src="/dashboard-screenshot.png" alt="SkimpyClaw Dashboard Overview" class="hero-screenshot primary" />
    <img src="/dashboard-audit.png" alt="SkimpyClaw Audit Log" class="hero-screenshot secondary" />
  </div>
</template>

<style scoped>
.hero-screenshots {
  position: relative;
  width: 520px;
  height: 420px;
}

.hero-screenshot {
  border-radius: 12px;
  border: 1px solid var(--vp-c-border);
  box-shadow: 0 8px 32px rgba(23, 16, 11, 0.1);
  width: 460px;
  position: absolute;
}

.hero-screenshot.primary {
  top: 0;
  left: 0;
  z-index: 2;
}

.hero-screenshot.secondary {
  top: 60px;
  left: 60px;
  z-index: 1;
  opacity: 0.85;
}

@media (max-width: 960px) {
  .hero-screenshots {
    width: 100%;
    height: auto;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .hero-screenshot {
    position: static;
    width: 100%;
    opacity: 1 !important;
  }
}
</style>
