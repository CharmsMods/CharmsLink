import re

with open('background remover and patcher.html', 'r', encoding='utf-8') as f:
    text = f.read()

# 1. HTML Sidebar insertion
html_insert = '''            <details class="settings-section">
                <summary>Manual Brush Tool</summary>
                <div class="settings-content">
                    <div class="control-group">
                        <div class="control-header">
                            <span>Brush Mode</span>
                        </div>
                        <select id="brushModeSelect" style="padding: 10px; background: #000000; color: #ffffff; border: 1px solid #ffffff; border-radius: 4px; outline: none; cursor: pointer; font-size: 0.9rem;">
                            <option value="off">Off (Cursor Pick)</option>
                            <option value="remove">Paint Remove (Erase)</option>
                            <option value="keep">Paint Keep (Restore)</option>
                            <option value="erase_brush">Eraser (Reset to Sliders)</option>
                        </select>
                    </div>

                    <div class="control-group">
                        <div class="control-header">
                            <span>Brush Size</span>
                            <span class="value-display" id="brushSizeVal">50px</span>
                        </div>
                        <input type="range" id="brushSizeSlider" min="1" max="1000" value="50" step="1">
                    </div>

                    <div class="control-group">
                        <div class="control-header">
                            <span>Brush Hardness</span>
                            <span class="value-display" id="brushHardnessVal">50%</span>
                        </div>
                        <input type="range" id="brushHardnessSlider" min="0" max="100" value="50" step="1">
                    </div>

                    <div class="control-group">
                        <button id="clearBrushBtn" style="padding: 10px; background: #000000; border: 1px solid #ffffff; color: #ffffff; border-radius: 4px; cursor: pointer; font-size: 0.85rem; font-weight: bold;">Clear All Strokes</button>
                    </div>
                </div>
            </details>

            <details class="settings-section">'''
text = text.replace('            <details class=\"settings-section\">\n                <summary>Advanced Mask Tools</summary>', html_insert + '\n                <summary>Advanced Mask Tools</summary>')


# 2. JS DOM Elements
js_dom = '''        // Brush Tool Elements
        const brushModeSelect = document.getElementById('brushModeSelect');
        const brushSizeSlider = document.getElementById('brushSizeSlider');
        const brushSizeVal = document.getElementById('brushSizeVal');
        const brushHardnessSlider = document.getElementById('brushHardnessSlider');
        const brushHardnessVal = document.getElementById('brushHardnessVal');
        const clearBrushBtn = document.getElementById('clearBrushBtn');
        const brushCursor = document.getElementById('brushCursor');

        // Gl State'''
text = text.replace('        // Gl State', js_dom)

# 3. Brush State variables
js_vars = '''        // Brush State
        const brushCanvas = document.createElement('canvas');
        const brushCtx = brushCanvas.getContext('2d', { willReadFrequently: true });
        let brushTex = null;
        let brushMaskDirty = false;

        // Patch state'''
text = text.replace('        // Patch state', js_vars)

# 4. Shader changes - u_brushTex uniform and fragment shader logic
old_uniforms = 'uniform int u_protectedCount;\n            uniform vec4 u_protectedColors[8]; // rgb, tolerance'
new_uniforms = 'uniform int u_protectedCount;\n            uniform vec4 u_protectedColors[8]; // rgb, tolerance\n            uniform sampler2D u_brushTex;'
text = text.replace(old_uniforms, new_uniforms)

old_fs_end = '                // Patch overrides all\n                vec4 computedColor = vec4(defringedColor, alpha * originalColor.a);\n                gl_FragColor = mix(computedColor, patchColor, patchColor.a);\n            }'
new_fs_end = '''                // Patch overrides all
                vec4 computedColor = vec4(defringedColor, alpha * originalColor.a);
                vec4 finalColor = mix(computedColor, patchColor, patchColor.a);
                
                // --- Apply Manual Brush Mask ---
                vec4 brushData = texture2D(u_brushTex, v_texCoord);
                float forceRemove = brushData.r;
                float forceKeep = brushData.g;
                
                // 1. Force removal overrides alpha down
                finalColor.a *= (1.0 - forceRemove);
                // 2. Force keep restores alpha and original RGB perfectly
                finalColor.a = mix(finalColor.a, originalColor.a, forceKeep);
                finalColor.rgb = mix(finalColor.rgb, originalColor.rgb, forceKeep);
                
                // Output color
                gl_FragColor = finalColor;
            }'''
text = text.replace(old_fs_end, new_fs_end)

# 5. Bind brush texture in render()
old_render_tex = '''            // Set bindings for multi-textures
            const floodTexLoc = gl.getUniformLocation(program, "u_floodMask");'''
new_render_tex = '''            const brushTexLoc = gl.getUniformLocation(program, "u_brushTex");
            
            // Set bindings for multi-textures
            const floodTexLoc = gl.getUniformLocation(program, "u_floodMask");'''
text = text.replace(old_render_tex, new_render_tex)

old_tex_bind = '''                gl.uniform1i(floodTexLoc, 1);
            } else {
                gl.uniform1i(floodModeLoc, 0);
            }'''
new_tex_bind = '''                gl.uniform1i(floodTexLoc, 1);
            } else {
                gl.uniform1i(floodModeLoc, 0);
            }
            
            if (brushTex) {
                gl.activeTexture(gl.TEXTURE2);
                gl.bindTexture(gl.TEXTURE_2D, brushTex);
                gl.uniform1i(brushTexLoc, 2);
            }'''
text = text.replace(old_tex_bind, new_tex_bind)


with open('background remover and patcher.html', 'w', encoding='utf-8') as f:
    f.write(text)
