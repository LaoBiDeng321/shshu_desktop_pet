<script setup lang="ts">
import PetCanvas from "@/features/pet/PetCanvas.vue";
</script>

<template>
  <PetCanvas />
</template>

<style>
html, body {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  background: transparent;
}
body {
  overflow: hidden;
}
#app {
  width: 100%;
  height: 100%;
}
</style>
