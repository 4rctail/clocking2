// pkg runs CommonJS entrypoints best; bridge to ESM app entry.
(async () => {
  await import('./index.js');
})();
