/*
 * Copyright (c) 2025 Charm?
 *
 * Licensed under the MIT License. See LICENSE file in the project root for full license information.
 *
 * SPDX-License-Identifier: MIT
 *
 * Website frontend helper functions.
 */








document.addEventListener('DOMContentLoaded', () => {
    const menuIcon = document.getElementById('menuIcon');
    const dropdownMenu = document.getElementById('dropdownMenu');
    const themeToggle = document.getElementById('themeToggle');
    const splitModeToggle = document.getElementById('splitModeToggle'); // Split mode toggle button
    const body = document.body;
    const darkModeSplitOverlay = document.getElementById('dark-mode-split-overlay');

    // Hamburger menu open/close logic
    if (menuIcon && dropdownMenu) {
        menuIcon.addEventListener('click', () => {
            dropdownMenu.classList.toggle('open');
            menuIcon.classList.toggle('active');
        });

        document.addEventListener('click', (event) => {
            if (!dropdownMenu.contains(event.target) && !menuIcon.contains(event.target)) {
                dropdownMenu.classList.remove('open');
                menuIcon.classList.remove('active');
            }
        });
    }

    // Theme toggle (dark/light mode) logic
    if (themeToggle) {
        themeToggle.addEventListener('click', () => {
            // Exit split mode if active before toggling theme
            if (body.classList.contains('split-active')) {
                body.classList.remove('split-active');
                darkModeSplitOverlay.style.clipPath = 'polygon(0 0, 0 0, 0 0)'; // Hide split overlay
                // Theme will be toggled below
            }

            body.classList.toggle('dark-mode');
            if (body.classList.contains('dark-mode')) {
                themeToggle.innerHTML = '<i class="fas fa-moon"></i>';
            } else {
                themeToggle.innerHTML = '<i class="fas fa-sun"></i>';
            }
        });

        // Set theme icon on initial load
        if (body.classList.contains('dark-mode')) {
            themeToggle.innerHTML = '<i class="fas fa-moon"></i>';
        } else {
            themeToggle.innerHTML = '<i class="fas fa-sun"></i>';
        }
    }

    // Split mode toggle logic
    if (splitModeToggle && darkModeSplitOverlay) {
        splitModeToggle.addEventListener('click', () => {
            // Toggle split mode class on body
            body.classList.toggle('split-active');

            // Remove dark mode when entering split mode
            if (body.classList.contains('split-active')) {
                body.classList.remove('dark-mode'); // Force light mode as base
                themeToggle.innerHTML = '<i class="fas fa-sun"></i>'; // Set icon to sun

                // Show split overlay
                darkModeSplitOverlay.style.clipPath = 'polygon(0 100%, 100% 0, 100% 100%, 0% 100%)';
            } else {
                // Hide split overlay when exiting split mode
                darkModeSplitOverlay.style.clipPath = 'polygon(0 0, 0 0, 0 0, 0 0)';
                // Theme state is unchanged; user can toggle as needed
            }
        });
    }
});