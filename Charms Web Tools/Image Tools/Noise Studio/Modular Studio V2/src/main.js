import { bootstrapStudioApp } from './app/bootstrap.js';

window.addEventListener('DOMContentLoaded', async () => {
    await bootstrapStudioApp({
        root: document.getElementById('app')
    });
});
