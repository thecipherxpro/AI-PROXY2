// app.js - Hostinger CommonJS Entry Point for Phusion Passenger
(async () => {
  try {
    await import('./oc-api-proxy.mjs');
  } catch (err) {
    console.error('Failed to bootstrap oc-api-proxy.mjs:', err);
    process.exit(1);
  }
})();
