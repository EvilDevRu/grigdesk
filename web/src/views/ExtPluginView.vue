<template>
  <div class="tool-route-adapter" :data-tool-route="`ext:${$route.params.id}`" aria-hidden="true"></div>
</template>

<script setup>
// Route-adapter страницы пользовательского плагина: саму панель-iframe монтирует
// единственный ToolHost, как и у встроенных инструментов.
</script>
