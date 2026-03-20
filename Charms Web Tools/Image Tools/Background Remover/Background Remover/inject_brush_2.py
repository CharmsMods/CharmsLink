with open('background remover and patcher.html', 'r', encoding='utf-8') as f:
    text = f.read()

# 1. Inject Brush initialization functions before unction resizeCanvas()
brush_funcs = '''
        // --------------------------------------------------------------------------
        // BRUSH MASK TOOL LOGIC
        // --------------------------------------------------------------------------
        brushModeSelect.addEventListener('change', (e) => {
            if (e.target.value === 'off') {
                brushCursor.style.display = 'none';
                canvas.style.cursor = 'crosshair';
            } else {
                canvas.style.cursor = 'none';
                brushCursor.style.display = 'block';
                updateBrushCursorScale();
            }
        });

        brushSizeSlider.addEventListener('input', (e) => {
            brushSizeVal.textContent = e.target.value + 'px';
            updateBrushCursorScale();
        });

        brushHardnessSlider.addEventListener('input', (e) => {
            brushHardnessVal.textContent = e.target.value + '%';
        });

        clearBrushBtn.addEventListener('click', () => {
             if (brushCanvas && brushCanvas.width) {
                 brushCtx.fillStyle = 'black';
                 brushCtx.fillRect(0, 0, brushCanvas.width, brushCanvas.height);
                 brushMaskDirty = true;
                 requestRender();
             }
        });

        function updateBrushCursorScale() {
            if (brushModeSelect.value === 'off') return;
            const size = parseInt(brushSizeSlider.value);
            const cssDiameter = size * zoomScale;
            brushCursor.style.width = cssDiameter + 'px';
            brushCursor.style.height = cssDiameter + 'px';
        }

        function drawBrushStampLine(x1, y1, x2, y2, mode) {
            const size = parseInt(brushSizeSlider.value);
            const radius = size / 2;
            const hardness = parseInt(brushHardnessSlider.value) / 100;
            
            let rColor = 0; let gColor = 0;
            if (mode === 'remove') rColor = 1;
            if (mode === 'keep') gColor = 1;
            
            const dist = Math.hypot(x2 - x1, y2 - y1);
            const steps = Math.max(1, Math.floor(dist / (radius * 0.1)));
            
            brushCtx.globalCompositeOperation = 'source-over';
            
            for(let i=0; i<=steps; i++) {
                const t = steps === 0 ? 0 : i / steps;
                const cx = x1 + (x2 - x1) * t;
                const cy = y1 + (y2 - y1) * t;
                
                const grad = brushCtx.createRadialGradient(cx, cy, 0, cx, cy, radius);
                let coreStop = Math.max(0.001, hardness * 0.99); 
                
                grad.addColorStop(0, gba(, , 0, 1.0));
                grad.addColorStop(coreStop, gba(, , 0, 1.0));
                grad.addColorStop(1, gba(, , 0, 0.0));
                
                brushCtx.fillStyle = grad;
                brushCtx.beginPath();
                brushCtx.arc(cx, cy, radius, 0, Math.PI * 2);
                brushCtx.fill();
            }
        }
        
        function updateBrushTexture() {
            if (!brushCanvas || !brushCanvas.width) return;
            if (!brushTex) {
                brushTex = gl.createTexture();
            }
            gl.bindTexture(gl.TEXTURE_2D, brushTex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, brushCanvas);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        }

        function resizeCanvas() {'''
text = text.replace('        function resizeCanvas() {', brush_funcs)

# 2. Add brush texture upload inside render() and brush draw in pointer events
render_inject = '''        function requestRender() {
            if (isRendering) return;
            isRendering = true;
            requestAnimationFrame(() => {
                if (brushMaskDirty) {
                    updateBrushTexture();
                    brushMaskDirty = false;
                }
                render();
                isRendering = false;
            });
        }'''
text = text.replace('''        function requestRender() {
            if (isRendering) return;
            isRendering = true;
            requestAnimationFrame(() => {
                render();
                isRendering = false;
            });
        }''', render_inject)


# Mousedown
md_old = '''        canvasContainer.addEventListener('mousedown', (e) => {
            isMouseDown = true;
            
            if (e.button === 1 || e.button === 2) {
                // Middle/Right click pan
                isPanning = true;
                panStartX = e.clientX - panOffsetX;
                panStartY = e.clientY - panOffsetY;
                e.preventDefault();
                return;
            }

            if (patchModeToggle.checked && selectedPatchIndex !== -1) {'''

md_new = '''        canvasContainer.addEventListener('mousedown', (e) => {
            isMouseDown = true;
            
            if (e.button === 1 || e.button === 2) {
                // Middle/Right click pan
                isPanning = true;
                panStartX = e.clientX - panOffsetX;
                panStartY = e.clientY - panOffsetY;
                e.preventDefault();
                return;
            }
            
            if (brushModeSelect.value !== 'off') {
                const pos = getMousePos(e);
                lastMouseObj = pos;
                drawBrushStampLine(pos.x, pos.y, pos.x, pos.y, brushModeSelect.value);
                brushMaskDirty = true;
                requestRender();
                return;
            }

            if (patchModeToggle.checked && selectedPatchIndex !== -1) {'''
text = text.replace(md_old, md_new)

# Mousemove
mm_old = '''        canvasContainer.addEventListener('mousemove', (e) => {
            if (isPanning) {
                panOffsetX = e.clientX - panStartX;
                panOffsetY = e.clientY - panStartY;
                updateCanvasTransform();
                return;
            }

            if (patchModeToggle.checked && selectedPatchIndex !== -1 && isMouseDown) {'''

mm_new = '''        canvasContainer.addEventListener('mousemove', (e) => {
            if (brushModeSelect.value !== 'off') {
                const size = parseInt(brushSizeSlider.value);
                const cssDiameter = size * zoomScale;
                const cssRadius = cssDiameter / 2;
                const rect = canvasContainer.getBoundingClientRect();
                const offsetX = e.clientX - rect.left - cssRadius;
                const offsetY = e.clientY - rect.top - cssRadius;
                brushCursor.style.transform = 	ranslate(px, px);
            }

            if (isPanning) {
                panOffsetX = e.clientX - panStartX;
                panOffsetY = e.clientY - panStartY;
                updateCanvasTransform();
                return;
            }
            
            if (isMouseDown && brushModeSelect.value !== 'off') {
                const pos = getMousePos(e);
                if (lastMouseObj) {
                    drawBrushStampLine(lastMouseObj.x, lastMouseObj.y, pos.x, pos.y, brushModeSelect.value);
                } else {
                    drawBrushStampLine(pos.x, pos.y, pos.x, pos.y, brushModeSelect.value);
                }
                lastMouseObj = pos;
                brushMaskDirty = true;
                requestRender();
                return;
            }

            if (patchModeToggle.checked && selectedPatchIndex !== -1 && isMouseDown) {'''
text = text.replace(mm_old, mm_new)

# Wheel
wh_old = '''            updateCanvasTransform();
            e.preventDefault();
        });'''
wh_new = '''            updateCanvasTransform();
            updateBrushCursorScale();
            e.preventDefault();
        });'''
text = text.replace(wh_old, wh_new)

# 3. Canvas brush clear on new image loaded
img_load_old = '''            originalImage.onload = () => {
                canvas.width = originalImage.width;
                canvas.height = originalImage.height;
                
                // Set uniform resolution for shaders'''
img_load_new = '''            originalImage.onload = () => {
                canvas.width = originalImage.width;
                canvas.height = originalImage.height;
                
                brushCanvas.width = originalImage.width;
                brushCanvas.height = originalImage.height;
                brushCtx.fillStyle = 'black';
                brushCtx.fillRect(0, 0, brushCanvas.width, brushCanvas.height);
                brushMaskDirty = true;
                
                // Set uniform resolution for shaders'''
text = text.replace(img_load_old, img_load_new)


with open('background remover and patcher.html', 'w', encoding='utf-8') as f:
    f.write(text)
