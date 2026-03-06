function drawGrid(ctx, width, height, steps, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    for (let i = 1; i < steps; i += 1) {
        const x = (width / steps) * i;
        const y = (height / steps) * i;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
    }
}

export function updateHistogram(canvas, avgEl, resEl, pixels, width, height, renderWidth, renderHeight) {
    if (!canvas || !pixels?.length) return;
    const ctx = canvas.getContext('2d');
    const cw = canvas.width;
    const ch = canvas.height;
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cw, ch);
    drawGrid(ctx, cw, ch, 8, 'rgba(17, 17, 17, 0.08)');

    const hist = new Uint32Array(256);
    let totalLum = 0;
    let count = 0;
    const sampleRate = Math.max(1, Math.floor((width * height) / 12000));
    for (let i = 0; i < pixels.length; i += sampleRate * 4) {
        const lum = Math.round(pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722);
        hist[lum] += 1;
        totalLum += lum;
        count += 1;
    }

    let max = 0;
    hist.forEach((value) => {
        if (value > max) max = value;
    });

    ctx.fillStyle = 'rgba(17, 17, 17, 0.88)';
    for (let i = 0; i < hist.length; i += 1) {
        const x = (i / 255) * cw;
        const h = max ? (hist[i] / max) * ch : 0;
        ctx.fillRect(x, ch - h, Math.max(1, cw / 256), h);
    }

    if (avgEl) avgEl.textContent = `${Math.round(totalLum / Math.max(count, 1))}`;
    if (resEl) resEl.textContent = `${renderWidth} x ${renderHeight}`;
}

export function updateVectorscope(canvas, avgEl, pixels, width, height) {
    if (!canvas || !pixels?.length) return;
    const ctx = canvas.getContext('2d');
    const cw = canvas.width;
    const ch = canvas.height;
    const centerX = cw / 2;
    const centerY = ch / 2;
    const radius = Math.min(cw, ch) * 0.45;
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cw, ch);

    ctx.strokeStyle = 'rgba(17, 17, 17, 0.1)';
    ctx.lineWidth = 1;
    for (let ring = 1; ring <= 4; ring += 1) {
        ctx.beginPath();
        ctx.arc(centerX, centerY, (radius / 4) * ring, 0, Math.PI * 2);
        ctx.stroke();
    }

    let saturationSum = 0;
    let sampleCount = 0;
    const sampleRate = Math.max(1, Math.floor((width * height) / 16000));
    for (let i = 0; i < pixels.length; i += sampleRate * 4) {
        const r = pixels[i] / 255;
        const g = pixels[i + 1] / 255;
        const b = pixels[i + 2] / 255;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const delta = max - min;
        const sat = max === 0 ? 0 : delta / max;
        let hue = 0;
        if (delta !== 0) {
            if (max === r) hue = ((g - b) / delta + (g < b ? 6 : 0)) / 6;
            else if (max === g) hue = ((b - r) / delta + 2) / 6;
            else hue = ((r - g) / delta + 4) / 6;
        }
        const angle = hue * Math.PI * 2 - Math.PI / 2;
        const x = centerX + Math.cos(angle) * radius * sat;
        const y = centerY + Math.sin(angle) * radius * sat;
        ctx.fillStyle = `rgba(${pixels[i]}, ${pixels[i + 1]}, ${pixels[i + 2]}, 0.12)`;
        ctx.fillRect(x, y, 2, 2);
        saturationSum += sat;
        sampleCount += 1;
    }

    if (avgEl) avgEl.textContent = `${Math.round((saturationSum / Math.max(sampleCount, 1)) * 100)}%`;
}

export function updateParade(canvas, pixels, width, height) {
    if (!canvas || !pixels?.length) return;
    const ctx = canvas.getContext('2d');
    const cw = canvas.width;
    const ch = canvas.height;
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cw, ch);
    const sectionWidth = cw / 3;
    const actualWidth = sectionWidth - 16;
    drawGrid(ctx, cw, ch, 6, 'rgba(17, 17, 17, 0.08)');
    const maxSamples = 20000;
    const sampleRate = Math.max(1, Math.floor((width * height) / maxSamples));
    const stride = sampleRate * 4;

    ctx.fillStyle = 'rgba(255, 85, 85, 0.12)';
    for (let i = 0; i < pixels.length; i += stride) {
        const x = (i / 4) % width;
        ctx.fillRect((x / width) * actualWidth + 8, ch - (pixels[i] / 255) * ch, 1.25, 1.25);
    }
    ctx.fillStyle = 'rgba(102, 255, 145, 0.12)';
    for (let i = 0; i < pixels.length; i += stride) {
        const x = (i / 4) % width;
        ctx.fillRect(sectionWidth + (x / width) * actualWidth + 8, ch - (pixels[i + 1] / 255) * ch, 1.25, 1.25);
    }
    ctx.fillStyle = 'rgba(82, 160, 255, 0.12)';
    for (let i = 0; i < pixels.length; i += stride) {
        const x = (i / 4) % width;
        ctx.fillRect(sectionWidth * 2 + (x / width) * actualWidth + 8, ch - (pixels[i + 2] / 255) * ch, 1.25, 1.25);
    }
}
