const fs = require('fs');

const registryStr = fs.readFileSync('src/registry/layerRegistry.json', 'utf8');
const registry = JSON.parse(registryStr);
const layersByShader = {};

registry.layers.forEach(layer => {
    let params = [];
    if (layer.controls) {
        layer.controls.forEach(c => {
            if (c.label) params.push(c.label);
            else if (c.type === 'dngDevelopEditor') params.push('Full RAW Decoder Params (Exposure, Tint, Interpretation, etc.)');
            else if (c.type === 'bgPatcherEditor') params.push('Flood Fill, Explicit Patches, Tolerances, Defringe Radios');
            else if (c.type === 'textLayerEditor') params.push('Font Box, Text String, Rotation, Absolute Alpha');
            else if (c.type === 'generatorLayerEditor') params.push('Generator String Context, Dimensions Data');
            else if (c.type === 'expanderEditor') params.push('Padding Factor, RGBA Outfill Data');
        });
    }
    
    if (layer.shader) {
        layersByShader[layer.shader] = {
            name: layer.label || layer.layerId,
            description: layer.description || '',
            params: params,
            type: 'Base Engine Module'
        };
    }
    if (layer.extraPrograms) {
        layer.extraPrograms.forEach(ep => {
            if (ep.shader) {
                layersByShader[ep.shader] = {
                    name: `Mask Component / GPU Utility for ${layer.label || layer.layerId}`,
                    description: 'Internal rendering utility shader for masking variations or sub-passes.',
                    params: [],
                    type: 'Associated Sub-Module'
                };
            }
        });
    }
});

let md = `# OpenGL Rendering Modules (Shaders Registry)

> **C++ Architecture Context:** Standard OpenGL natively requires Fragment Shaders (written in GLSL) to execute parallel operations on the GPU. While an application can compile them from inline C++ strings, keeping \`.frag\` files as external, interchangeable assets is a common and required architecture convention for a shader-driven engine. Therefore, these exact shaders must be migrated, compiled via \`glCompileShader\`, and executed by the native stack pipeline.

This document catalogs every single node operation within the engine, treating them by their proper name as sequential **Rendering Modules**.

`;

const files = fs.readdirSync('Shaders').filter(f => f.endsWith('.frag') || f.endsWith('.vert'));

files.forEach(file => {
    const shaderPath = `Shaders/${file}`;
    const info = layersByShader[shaderPath];
    
    // Custom overrides to avoid generic tags
    let name = info ? info.name : null;
    let desc = info ? info.description : null;
    let type = info ? info.type : null;
    let params = info ? info.params : [];

    if (!info) {
        type = 'Core Math Shader';
        if (file === 'textOverlay.frag') { name = 'Text Overlay Compositor'; desc = 'Explicitly composites an affine-transformed glyph surface texture.'; }
        else if (file === 'lightLeaks.frag') { name = 'Light Leaks'; desc = 'Mathematically generated additive color streaks and film leak burns.'; }
        else if (file === 'radial.frag') { name = 'Radial Math Generator'; desc = 'Radial optical overlays and vignette gradient falloffs.'; }
        else if (file === 'vs-quad.vert') { name = 'Global Plane Vertex Geometry'; type = 'Vertex Shader'; desc = 'The singular 2D geometry vertex that maps the flat plane across screen space for fragments to draw onto.'; }
        else { name = 'Core Engine Utility'; desc = 'Low-level shader pipeline component like masking math, raw copying, or final sRGB conversions.'; }
    }

    md += `### ${name} \`${file}\`\n`;
    md += `- **Role:** ${type}\n`;
    if (desc) md += `- **Execution Description:** ${desc}\n`;
    if (params && params.length > 0) {
        md += `- **Controllable Engine Parameters:** ${params.join(', ')}\n`;
    }
    md += `\n`;
});

fs.writeFileSync('Stack-Rebuild-Docs/Editor/04_Shader_Registry.md', md, 'utf8');
console.log('Shader registry document updated with expanded module data!');
