document.addEventListener('DOMContentLoaded', () => {
    // Define the mod data (no images needed since we're ignoring them, keeping structure)
    const modsConfig = [
        { name: "2Fly.zip", folder: "2Fly" },
        { name: "aim_trainer.zip", folder: "aim_trainer" },
        { name: "Brick Mod.zip", folder: "Brick Mod" },
        { name: "AQUA-Mod.zip", folder: "AQUA-Mod" },
        { name: "BO$$ MOD V8 - enjoy!.zip", folder: "BO$$ MOD V8 - enjoy!" },
        { name: "Cream Mod.zip", folder: "Cream Mod" },
        { name: "Charm Mod.zip", folder: "Charm Mod" },
        { name: "Drop Mod.zip", folder: "Drop Mod" },
        { name: "Flash_mod.zip", folder: "Flash_mod" },
        { name: "FOV MOD.zip", folder: "FOV MOD" },
        { name: "Fugaz13-mod.zip", folder: "Fugaz13-mod" },
        { name: "Got to Got.zip", folder: "Got to Got" },
        { name: "green_and_white_mod.zip", folder: "green_and_white_mod" },
        { name: "Grey Mod.zip", folder: "Grey Mod" },
        { name: "hate_mod.zip", folder: "hate_mod" },
        { name: "Illumination Mod.zip", folder: "Illumination Mod" },
        { name: "Jolt_Mod_v1.zip", folder: "Jolt_Mod_v1" },
        { name: "Lava_mod.zip", folder: "Lava_mod" },
        { name: "Minogue-Mod-Oficial.zip", folder: "Minogue-Mod-Oficial" },
        { name: "Minty V2.zip", folder: "Minty V2" },
        { name: "HELL Mod.zip", folder: "HELL Mod" },
        { name: "Nio-mod-purple-main.zip", folder: "Nio-mod-purple-main" },
        { name: "NticxMod-v6.zip", folder: "NticxMod-v6" },
        { name: "OOOPS-Mod.zip", folder: "OOOPS-Mod" },
        { name: "PARADISE.zip", folder: "PARADISE" },
        { name: "Peru-Mod.zip", folder: "Peru-Mod" },
        { name: "PRE-ALPHA-DARKMODE.zip", folder: "PRE-ALPHA-DARKMODE" },
        { name: "pred_mod.zip", folder: "pred_mod" },
        { name: "Psychologixal-Mod.zip", folder: "Psychologixal-Mod" },
        { name: "Rainbow_mod_2.zip", folder: "Rainbow_mod_2" },
        { name: "Ren-Mod.zip", folder: "Ren-Mod" },
        { name: "RVNG Mod.zip", folder: "RVNG Mod" },
        { name: "Samu-mod.zip", folder: "Samu-mod" },
        { name: "Sketch Mod.zip", folder: "Sketch Mod" },
        { name: "Skipper-Mod.zip", folder: "Skipper-Mod" },
        { name: "skylux mod.zip", folder: "skylux mod" },
        { name: "Summer_mod.zip", folder: "Summer_mod" },
        { name: "Teen_Titans_Mod.zip", folder: "Teen_Titans_Mod" },
        { name: "The_Terminator_Mod_1.zip", folder: "The_Terminator_Mod_1" },
        { name: "TZ_Mod.zip", folder: "TZ_Mod" },
        { name: "vvsmod.zip", folder: "vvsmod" }
    ];

    const myModsList = [
        "Cream Mod",
        "Sketch Mod",
        "Charm Mod",
        "Grey Mod",
        "Illumination Mod"
    ];

    const myModsData = [];
    const communityModsData = [];

    modsConfig.forEach(mod => {
        const modData = {
            ...mod,
            link: `mod-download-card-pictures/${mod.folder}/${mod.name}`
        };

        const indexInMyMods = myModsList.indexOf(mod.folder);
        if (indexInMyMods !== -1) {
            myModsData[indexInMyMods] = modData;
        } else {
            communityModsData.push(modData);
        }
    });

    const communityGrid = document.getElementById('communityGrid');
    const myModsGrid = document.getElementById('myModsGrid');
    const messageModal = document.getElementById('messageModal');
    const modalMessage = document.getElementById('modalMessage');
    const modalCloseButton = document.getElementById('modalCloseButton');

    function showMessageModal(message) {
        modalMessage.textContent = message;
        messageModal.style.display = 'flex';
        // force reflow
        void messageModal.offsetWidth;
        messageModal.classList.add('visible');
    }

    function hideMessageModal() {
        messageModal.classList.remove('visible');
        setTimeout(() => {
            messageModal.style.display = 'none';
        }, 300);
    }

    modalCloseButton.addEventListener('click', hideMessageModal);
    messageModal.addEventListener('click', (event) => {
        if (event.target === messageModal) {
            hideMessageModal();
        }
    });

    function createModCard(mod, index) {
        const card = document.createElement('div');
        card.classList.add('mod-card');
        card.style.animationDelay = `${0.05 * index}s`;

        const downloadLink = mod.link;
        const buttonClass = downloadLink ? 'action-button download' : 'action-button coming-soon';
        const buttonText = downloadLink ? 'Download' : 'Coming Soon';
        const buttonDataLink = downloadLink ? `data-link="${downloadLink}"` : '';

        let displayName = mod.name;
        const extensions = ['.zip', '.7z', '.rar', '.exe', '.tar', '.gz', '.dmg'];
        for (const ext of extensions) {
            if (displayName.endsWith(ext)) {
                displayName = displayName.slice(0, -ext.length);
                break;
            }
        }
        displayName = displayName.replace(/_/g, ' ');
        displayName = displayName.replace(/-/g, ' ');
        displayName = displayName.replace(/\b(\w)/g, s => s.toUpperCase());
        displayName = displayName.trim().replace(/[,.]+$/, '');

        card.innerHTML = `
            <div class="card-content">
                <div class="download-loading-animation">
                    <div class="loader-ring"></div>
                </div>
                <h2>${displayName}</h2>
                <button class="${buttonClass}" ${buttonDataLink}><span>${buttonText}</span></button>
            </div>
        `;

        const actionButton = card.querySelector('.action-button');
        actionButton.addEventListener('click', (event) => {
            event.stopPropagation();
            if (!actionButton.classList.contains('coming-soon')) {
                const link = actionButton.dataset.link;
                const loadingAnimation = card.querySelector('.download-loading-animation');
                const h2 = card.querySelector('h2');
                const btn = card.querySelector('.action-button');

                // Animate to loading state
                h2.style.opacity = '0';
                h2.style.transform = 'translateY(-10px)';
                btn.style.opacity = '0';
                btn.style.transform = 'translateY(10px)';
                btn.style.pointerEvents = 'none';

                setTimeout(() => {
                    loadingAnimation.classList.add('show');
                }, 300);

                setTimeout(() => {
                    loadingAnimation.classList.remove('show');
                    setTimeout(() => {
                        h2.style.opacity = '1';
                        h2.style.transform = 'translateY(0)';
                        btn.style.opacity = '1';
                        btn.style.transform = 'translateY(0)';
                        btn.style.pointerEvents = 'auto';

                        if (link) {
                            window.location.href = link;
                        }
                    }, 300);
                }, 2000);
            } else {
                showMessageModal("This mod is coming soon!");
            }
        });

        // Adding smooth hover interactions for the radial gradient glow
        card.addEventListener('mousemove', (e) => {
            const rect = card.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            card.style.setProperty('--mouse-x', `${x}px`);
            card.style.setProperty('--mouse-y', `${y}px`);
        });

        return card;
    }

    communityModsData.forEach((mod, index) => {
        communityGrid.appendChild(createModCard(mod, index));
    });

    myModsData.forEach((mod, index) => {
        if (mod) {
            myModsGrid.appendChild(createModCard(mod, index));
        }
    });
});