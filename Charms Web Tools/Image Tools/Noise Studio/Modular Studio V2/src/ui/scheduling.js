export function nextPaint() {
    return new Promise((resolve) => {
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => requestAnimationFrame(resolve));
            return;
        }
        setTimeout(resolve, 0);
    });
}

export async function maybeYieldToUi(index = 0, every = 1) {
    const interval = Math.max(1, Math.round(Number(every) || 1));
    if (((Math.max(0, Math.round(Number(index) || 0)) + 1) % interval) !== 0) return;
    await nextPaint();
}
