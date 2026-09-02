<script setup lang="ts">
import { ref, watch } from "vue";

const props = withDefaults(
  defineProps<{
    text: string;
    duration?: number;
  }>(),
  {
    duration: 2500,
  }
);

const emit = defineEmits<{
  (e: "close"): void;
}>();

const visible = ref(false);
const fading = ref(false);

let timer: ReturnType<typeof setTimeout> | null = null;

watch(
  () => props.text,
  (val) => {
    // 清除上一个定时器
    if (timer) clearTimeout(timer);

    if (!val) {
      visible.value = false;
      fading.value = false;
      return;
    }

    visible.value = true;
    fading.value = false;

    timer = setTimeout(() => {
      fading.value = true;
      timer = setTimeout(() => {
        visible.value = false;
        fading.value = false;
        emit("close");
      }, 300);
    }, props.duration);
  }
);
</script>

<template>
  <div v-if="visible" class="bubble" :class="{ 'bubble--fading': fading }">
    <span class="bubble__text">{{ text }}</span>
    <div class="bubble__arrow" />
  </div>
</template>

<style scoped>
.bubble {
  position: absolute;
  top: 100px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 100;
  padding: 6px 14px;
  background: rgba(0, 0, 0, 0.72);
  backdrop-filter: blur(6px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 14px;
  color: #fff;
  font-size: 13px;
  white-space: nowrap;
  pointer-events: none;
  opacity: 1;
  transition: opacity 0.3s ease, transform 0.3s ease;
}

.bubble--fading {
  opacity: 0;
  transform: translateX(-50%) translateY(-6px);
}

.bubble__text {
  position: relative;
  z-index: 1;
}

/* 三角箭头 */
.bubble__arrow {
  position: absolute;
  bottom: -6px;
  left: 50%;
  transform: translateX(-50%);
  width: 0;
  height: 0;
  border-left: 6px solid transparent;
  border-right: 6px solid transparent;
  border-top: 6px solid rgba(0, 0, 0, 0.72);
}
</style>
