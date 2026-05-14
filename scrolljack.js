const panels = Array.from(document.querySelectorAll('.panel'));
const navLinks = Array.from(document.querySelectorAll('.quick-nav a'));
const progressFill = document.getElementById('progressFill');
const stage = document.getElementById('scrollStage');
const cursor = document.getElementById('cursor');
const creamModal = document.getElementById('creamModal');
const modalClose = document.getElementById('modalClose');
const menuToggle = document.getElementById('menuToggle');
const archiveMenu = document.getElementById('archiveMenu');
const archiveClose = document.getElementById('archiveClose');
const galleryTriggers = Array.from(document.querySelectorAll('.gallery-trigger'));

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const coarsePointer = window.matchMedia('(pointer: coarse)');
const mobileWidth = window.matchMedia('(max-width: 780px)');

let activeIndex = 0;
let touchStartY = 0;

function shouldJackScroll() {
    return !reducedMotion.matches && !coarsePointer.matches && !mobileWidth.matches;
}

function setActivePanel(index) {
    const nextIndex = Math.max(0, Math.min(index, panels.length - 1));

    activeIndex = nextIndex;

    panels.forEach((panel, panelIndex) => {
        panel.classList.toggle('is-active', panelIndex === activeIndex);
        panel.classList.toggle('was-before', panelIndex < activeIndex);
    });

    const activePanel = panels[activeIndex];
    const activeId = activePanel.id;
    document.body.classList.toggle('on-intro', activeId === 'intro');

    navLinks.forEach(link => {
        link.classList.toggle('is-current', link.getAttribute('href') === `#${activeId}`);
    });

    if (progressFill) {
        progressFill.style.width = `${((activeIndex + 1) / panels.length) * 100}%`;
    }

    history.replaceState(null, '', `#${activeId}`);
}

function movePanel(direction) {
    if (!shouldJackScroll()) return;

    const next = activeIndex + direction;
    if (next < 0 || next >= panels.length) return;

    setActivePanel(next);
}

function panelIndexFromHash() {
    const hash = window.location.hash;
    if (!hash) return 0;
    const index = panels.findIndex(panel => `#${panel.id}` === hash);
    return index >= 0 ? index : 0;
}

function openModal() {
    creamModal.classList.add('is-open');
    creamModal.setAttribute('aria-hidden', 'false');
}

function closeModal() {
    creamModal.classList.remove('is-open');
    creamModal.setAttribute('aria-hidden', 'true');
}

function openArchiveMenu() {
    archiveMenu.classList.add('is-open');
    archiveMenu.setAttribute('aria-hidden', 'false');
}

function closeArchiveMenu() {
    archiveMenu.classList.remove('is-open');
    archiveMenu.setAttribute('aria-hidden', 'true');
}

window.addEventListener('wheel', event => {
    if (!shouldJackScroll() || creamModal.classList.contains('is-open')) return;
    event.preventDefault();
    if (Math.abs(event.deltaY) < 12) return;
    movePanel(event.deltaY > 0 ? 1 : -1);
}, { passive: false });

window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && creamModal.classList.contains('is-open')) {
        closeModal();
        return;
    }

    if (event.key === 'Escape' && archiveMenu.classList.contains('is-open')) {
        closeArchiveMenu();
        return;
    }

    if (!shouldJackScroll() || archiveMenu.classList.contains('is-open')) return;

    if (['ArrowDown', 'PageDown', ' '].includes(event.key)) {
        event.preventDefault();
        movePanel(1);
    }

    if (['ArrowUp', 'PageUp'].includes(event.key)) {
        event.preventDefault();
        movePanel(-1);
    }

    if (event.key === 'Home') {
        event.preventDefault();
        setActivePanel(0);
    }

    if (event.key === 'End') {
        event.preventDefault();
        setActivePanel(panels.length - 1);
    }
});

window.addEventListener('touchstart', event => {
    touchStartY = event.touches[0].clientY;
}, { passive: true });

window.addEventListener('touchend', event => {
    if (!shouldJackScroll()) return;
    const endY = event.changedTouches[0].clientY;
    const delta = touchStartY - endY;
    if (Math.abs(delta) > 50) {
        movePanel(delta > 0 ? 1 : -1);
    }
}, { passive: true });

navLinks.forEach(link => {
    link.addEventListener('click', event => {
        const targetId = link.getAttribute('href');
        const targetIndex = panels.findIndex(panel => `#${panel.id}` === targetId);

        if (targetIndex < 0) return;

        if (shouldJackScroll()) {
            event.preventDefault();
            setActivePanel(targetIndex);
        }
    });
});

document.querySelectorAll('a[href^="#"]').forEach(link => {
    link.addEventListener('click', event => {
        const targetIndex = panels.findIndex(panel => `#${panel.id}` === link.getAttribute('href'));
        if (targetIndex >= 0 && shouldJackScroll()) {
            event.preventDefault();
            setActivePanel(targetIndex);
        }
    });
});

document.addEventListener('mousemove', event => {
    if (!cursor || !shouldJackScroll()) return;
    cursor.style.transform = `translate(${event.clientX}px, ${event.clientY}px) translate(-50%, -50%)`;

    document.querySelectorAll('.magnetic').forEach(element => {
        const rect = element.getBoundingClientRect();
        const x = event.clientX - (rect.left + rect.width / 2);
        const y = event.clientY - (rect.top + rect.height / 2);
        const distance = Math.hypot(x, y);

        if (distance < 120) {
            element.style.transform = `translate(${x * 0.08}px, ${y * 0.08}px)`;
        } else {
            element.style.transform = '';
        }
    });
});

document.addEventListener('mouseover', event => {
    if (!cursor) return;
    cursor.classList.toggle('is-hovering', Boolean(event.target.closest('a, button')));
});

document.addEventListener('mouseout', event => {
    if (!cursor) return;
    if (event.target.closest('a, button')) {
        cursor.classList.remove('is-hovering');
    }
});

if (modalClose) {
    modalClose.addEventListener('click', closeModal);
}

if (creamModal) {
    creamModal.addEventListener('click', event => {
        if (event.target === creamModal) closeModal();
    });
}

galleryTriggers.forEach(trigger => {
    trigger.addEventListener('click', openModal);
});

if (menuToggle) {
    menuToggle.addEventListener('click', openArchiveMenu);
}

if (archiveClose) {
    archiveClose.addEventListener('click', closeArchiveMenu);
}

if (archiveMenu) {
    archiveMenu.addEventListener('click', event => {
        if (event.target === archiveMenu) closeArchiveMenu();
    });
}

window.addEventListener('hashchange', () => {
    if (shouldJackScroll()) setActivePanel(panelIndexFromHash());
});

function syncMode() {
    if (!shouldJackScroll()) {
        document.body.style.overflow = '';
        stage.style.overflow = '';
        panels.forEach(panel => {
            panel.classList.add('is-active');
            panel.classList.remove('was-before');
        });
        return;
    }

    document.body.style.overflow = 'hidden';
    setActivePanel(panelIndexFromHash());
}

[reducedMotion, coarsePointer, mobileWidth].forEach(query => {
    query.addEventListener('change', syncMode);
});

setActivePanel(panelIndexFromHash());
syncMode();
