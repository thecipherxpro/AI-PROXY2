(async () => {
  try {
    await import('./oc-api-proxy.mjs');
  } catch (err) {
    console.error('Failed to start oc-api-proxy.mjs:', err);
  }
})();
