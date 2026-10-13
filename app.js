// app.js - CommonJS Loader for Phusion Passenger
(async () => {
  try {
    await import('./oc-api-proxy.mjs');
  } catch (err) {
    console.error('Startup Error:', err);
  }
})();
