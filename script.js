const noiseCanvas = document.getElementById("crtNoise");

if (noiseCanvas) {
    const gl = noiseCanvas.getContext("webgl", {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: false,
    });

    if (gl) {
        const vertexSource = `
            attribute vec2 a_position;

            void main() {
                gl_Position = vec4(a_position, 0.0, 1.0);
            }
        `;

        const fragmentSource = `
            precision highp float;

            uniform float u_frame;

            float hash13(vec3 p3) {
                p3 = fract(p3 * 0.1031);
                p3 += dot(p3, p3.yzx + 33.33);
                return fract((p3.x + p3.y) * p3.z);
            }

            void main() {
                vec2 pixel = floor(gl_FragCoord.xy);
                float grain = hash13(vec3(pixel, u_frame));
                float luma = 0.232 + (grain - 0.5) * 0.056;

                gl_FragColor = vec4(vec3(luma), 1.0);
            }
        `;

        const compileShader = (type, source) => {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);

            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                console.warn(gl.getShaderInfoLog(shader));
                gl.deleteShader(shader);
                return null;
            }

            return shader;
        };

        const vertexShader = compileShader(gl.VERTEX_SHADER, vertexSource);
        const fragmentShader = compileShader(gl.FRAGMENT_SHADER, fragmentSource);

        if (vertexShader && fragmentShader) {
            const program = gl.createProgram();
            gl.attachShader(program, vertexShader);
            gl.attachShader(program, fragmentShader);
            gl.linkProgram(program);

            if (gl.getProgramParameter(program, gl.LINK_STATUS)) {
                const positionLocation = gl.getAttribLocation(program, "a_position");
                const frameLocation = gl.getUniformLocation(program, "u_frame");
                const buffer = gl.createBuffer();
                let frame = 0;

                gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
                gl.bufferData(
                    gl.ARRAY_BUFFER,
                    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
                    gl.STATIC_DRAW
                );

                const resizeCanvas = () => {
                    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
                    const width = Math.floor(window.innerWidth * pixelRatio);
                    const height = Math.floor(window.innerHeight * pixelRatio);

                    if (noiseCanvas.width !== width || noiseCanvas.height !== height) {
                        noiseCanvas.width = width;
                        noiseCanvas.height = height;
                    }

                    gl.viewport(0, 0, noiseCanvas.width, noiseCanvas.height);
                };

                const render = () => {
                    resizeCanvas();
                    gl.useProgram(program);
                    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
                    gl.enableVertexAttribArray(positionLocation);
                    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
                    gl.uniform1f(frameLocation, frame);
                    gl.drawArrays(gl.TRIANGLES, 0, 6);
                    frame += 1;
                    requestAnimationFrame(render);
                };

                requestAnimationFrame(render);
            } else {
                console.warn(gl.getProgramInfoLog(program));
            }
        }
    }
}

const projectPreview = document.querySelector(".project-preview");
const projectPreviewImages = document.querySelectorAll(".project-preview-image");
const projectLinks = document.querySelectorAll(".project-link[data-preview]");
const workSection = document.querySelector(".work-section");

if (projectPreview && projectPreviewImages.length === 2) {
    let activePreviewIndex = 0;
    let activePreviewSrc = projectPreviewImages[activePreviewIndex].getAttribute("src");

    const showPreviewImage = (src) => {
        projectPreview.classList.add("is-visible");

        if (src === activePreviewSrc) {
            return;
        }

        const nextPreviewIndex = activePreviewIndex === 0 ? 1 : 0;
        const activeImage = projectPreviewImages[activePreviewIndex];
        const nextImage = projectPreviewImages[nextPreviewIndex];

        const activateNextImage = () => {
            requestAnimationFrame(() => {
                nextImage.classList.add("is-active");
                activeImage.classList.remove("is-active");
                activePreviewIndex = nextPreviewIndex;
                activePreviewSrc = src;
            });
        };

        nextImage.onload = activateNextImage;
        nextImage.src = src;

        if (nextImage.complete) {
            activateNextImage();
        }
    };

    projectLinks.forEach((link) => {
        const showPreview = () => {
            showPreviewImage(link.dataset.preview);
        };

        link.addEventListener("mouseenter", showPreview);
        link.addEventListener("focus", showPreview);
        link.addEventListener("blur", () => {
            projectPreview.classList.remove("is-visible");
        });
    });

    if (workSection) {
        workSection.addEventListener("mouseleave", () => {
            projectPreview.classList.remove("is-visible");
        });
    }
}

const vengeModalTrigger = document.querySelector("[data-venge-modal]");
const vengeModal = document.getElementById("vengeLinks");

const closeVengeModal = () => {
    if (vengeModal) {
        vengeModal.classList.remove("is-open");
        vengeModal.setAttribute("aria-hidden", "true");
        document.body.classList.remove("is-modal-open");
    }
};

if (vengeModalTrigger && vengeModal) {
    vengeModalTrigger.addEventListener("click", (event) => {
        event.preventDefault();
        vengeModal.classList.add("is-open");
        vengeModal.setAttribute("aria-hidden", "false");
        document.body.classList.add("is-modal-open");
    });

    vengeModal.addEventListener("click", (event) => {
        if (event.target === vengeModal) {
            closeVengeModal();
        }
    });
}

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        closeVengeModal();
    }
});

document.querySelectorAll('a[href^="#"]').forEach((link) => {
    link.addEventListener("click", (event) => {
        if (event.defaultPrevented) {
            return;
        }

        const target = document.querySelector(link.getAttribute("href"));

        if (!target) {
            return;
        }

        event.preventDefault();
        target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
});
