THIS FILE IS TO BE USED AS AN IMPLIMNATION GUIDE FOR THE SETTINGS TAB, when tasks are completed, mark them with [DONE] right above the line the task or description starts on.
Do NOT try to impliment all things at once, it's important to understand that, although the UI of the settings tab and structure may not be complicated or difficult to build, what will take time is making sure that it can reliably interface with the site and actually set settings values corretly, and that the site will listen to its authority, and not just be a fake UI that doesnt actually set things all the time.
Plan of action:
[DONE]
Build the framwork for the settings Tab UI and make it match the rest of the site's UI vibe.
[DONE]
Then move to implimenting in 1 and only 1 catagory at a time, making sure that it works perfectly before moving on to the next catagory.
[DONE]
Spend time hooking up each setting to the site's state and making sure everything works correctly.


[DONE]
# Settings Tab General information/structure

The Settings tab will sit on the universal site tab bar to the left of the "Logs" tab and serve as the centralized hub for app-wide preferences and settings that will importantly, be saved in local storage for the site to remember between loads.

Organization and structure of the UI of the settings Tab should be a list of categories that the user can click on to expand to open and see the settings for that category in the center of the page in list format with any nesissary buttons sliders toggles and boxes for any settings.
left side catagory 1 can be just general stuff that applies to everything or in general scenarios.
left side catagory 2 can be for the library tab.
left side catagory 3 can be for the editor tab.
left side catagory 4 can be for the stitch tab (leaving this empty for now for planning and implimentation, just as an empty catagory so do NOT put any time into it at all right now).
left side catagory 5 can be for the 3d tab.
left side catagory 6 can be for the logs tab. 



notes:
-Things that should persist across the page being loaded in, should be stored in local storage for the site to remember between loads.

---

[DONE]
### Animations and Color, and making sure the user understands/trusts that the site indeed set what they asked it to.
**Design**
Give this tab a lot of visual feed back using color and animations for actions the user takes on it, to show that something actually happened.
ENSURE that this tab has its own hookup to the Logs tab, so it can send it's own logs to the logs tab for reporting.

---

### Start of Center conetent for each of the catagories, that will be situated in the center of the page when a catagory is clicked on.


[DONE]
## Category 1: General Settings

[DONE]
Most important function of the general catagory, allowing the user to export and import the state of the settings tab so they can give a config of the site to someone else.

Currently, some settings exist in multiple toolbars, taking up valuable horizontal space. a good example of this is:
[DONE]
- **Dark mode toggle** on the editor tab, which is a classic site-wide setting perfectly suited for the top-level Settings tab instead of the editor tab.

A place to set global application preferences for operations.
[DONE]
- **Save Image On Save**: Global toggle (`state.ui.saveImageOnSave` from architecture context) to dictate default download behavior during app saves/exports.
[DONE]
- **Site-Wide Hardware Limits / Workers**: A place to enforce max background workers and track how many cores the site has identified (fulfilling another item on your plans list).

[DONE]
## Category 2: Library Tab Settings

[DONE]
### Maintenance & Storage
[DONE]
- **Database Storage Info**: Display how much local storage the library is using and provide buttons to clear cache or wipe the library and or assets completely.
[DONE]
- **Automatic Library Loading**: A setting to configure whether the Library bootstraps entirely in the background on page-load without taking focus (supporting the "page load sequence" idea in the plans file). (really important that this is saved in local storage for the site to remember between loads)
[DONE]
- **Purge and Heal**: 2 buttons, one that scan through all of the library editor json project files, and see if they have that finished rendered image as well as the original image. The user can click either "Purge" to remove all of the rendered images from each of the project json editor files (not at all touching the original image or the setting in the json file), or "Heal" to attempt to re-render all of the missing images. (this should be done in the background and not block the UI, along with logging the entire process in the logs tab)
[DONE]
- **Storage Pressure Alerts**: A threshold setting (e.g., 80% full) to warn the user when the browser's IndexedDB storage for the site is reaching its limit.
[DONE]
- **Orphaned Asset Cleanup**: A maintenance tool to identify and remove assets (images/models) that are no longer linked to any saved project JSON.

[DONE]
### Gallery UI Preferences
[DONE]
- **Default View Layout**: Toggle between **Grid View** (large thumbnails) and **List View** (compact details) for high-density libraries.
[DONE]
- **Persistent Sort Order**: Choose the default sorting method (e.g., "Newest First", "Name A-Z", or "Size") that applies every time the tab is opened; these sorting settings should still work in the side tab for the library, but the default is what we are setting.
[DONE]
- **Asset Preview Quality**: Control the resolution/complexity of the 3D asset previews in the detail sidebar to prioritize either visual fidelity or performance.

[DONE]
### Import/Export Defaults
[DONE]
- **Secure Export by Default**: A toggle to prioritize the **Secure Export** (compressed/encrypted) format during the "Save Library" workflow.
[DONE]
- **Require Tag on project load/import into the library**: A toggle that, when enabled, when a user is trying to import a project json into the editor that is not a library file, a popup opens with a box for typing, and below that are any tags that already exist in the library. The user can select as many of them as they want, and then click continue, if the user does not select any tags and clicks continue, continue on without assigning tags.

[DONE]
## Category 3: Editor Tab Settings

[DONE]
### Viewport Toggles (De-cluttering the Toolbar)
The editor's `preview-toolbar` currently hosts several toggles that could be handled as global default preferences instead:
[DONE]
- **Default to High Quality Preview**: (`state.document.view.highQualityPreview`). Setting this as a global default allows power-users to always run high-quality rendering without toggling it per-session, ignoring what library project json files or uploaded json files try to set it to.
[DONE]
- **Hover Compare Original**: (`state.document.view.hoverCompareEnabled`). The user can decide if hovering over the canvas should show the original un-edited image by default, ignoring what library project json files or uploaded json files try to set it to.
[DONE]
- **Isolate Active Layer Chain**: (`state.document.view.isolateActiveLayerChain`). Global default preference for only rendering up to the active layer, ignoring what library project json files or uploaded json files try to set it to.

[DONE]
### Editor Sub-Tools Default Behaviors
[DONE]
- **Sub-Layer Previews Drawer**: (`state.document.view.layerPreviewsOpen`). A toggle to dictate whether the Sub-Layer Previews drawer starts open or collapsed by default for all layers.
[DONE]
- **A toggle to always have show original on hovering the main canvas enabled or disabled**

[DONE]
### Automation & Imports
[DONE]
- **Auto-Extract Palette On Load**: Since there handles for palette-upload (extracting colors from images), we could introduce a global setting that automatically attempts to extract an image's color palette into the pipeline as soon as an image is imported.
[DONE]
- **Transparency Checker Defaults**: A preference for the default checkerboard tone (Dark/Light) used when rendering alpha channels.

[DONE]
## Category 4: Stitch Tab Settings

*(Will not be covered in this analysis or in implimentation do not spend time on it, this is just here to show that it will be a catagory at some point)*

[DONE]
## Category 5: 3D Tab Settings

[DONE]
### Rendering & Quality Defaults
The 3D engine uses a hybrid Raster/Path-Tracer. Setting global defaults ensures a consistent starting point for every new scene.
[DONE]
- **Default Render Samples**: (`samplesTarget`). A global preference for the target sample count in the viewport, independent of individual project saved states.
[DONE]
- **Ray-Tracing Depth (Bounces)**: (`bounces` and `transmissiveBounces`). Master settings for default ray-tracing complexity (e.g., how many times light can bounce through glass).
[DONE]
- **Firefly & Noise Mitigation**: (`filterGlossyFactor`). A default value to suppress "fireflies" in glossy surfaces.
[DONE]
- **Denoiser Preferences**: (`denoiseEnabled`, `denoiseSigma`, `denoiseThreshold`). Dictates if the denoiser is active by default and how aggressive it should be.
[DONE]
- **Default Tone Mapping**: (`toneMapping`). Power-user setting to choose between ACES, Neutral, or None as the default look for any new 3D viewport.

[DONE]
### Viewport & Navigation
To de-clutter the 3D overlay, many viewport toggles can be moved here:
[DONE]
- **Navigation Mode**: (`cameraMode`). A global toggle to decide if the camera starts in **Orbit** (standard) or **Fly** (WASD) mode.
[DONE]
- **Fly Mode Sensitivity**: A preference to define the base speed of movement and rotation when in "Fly" mode.
[DONE]
- **Default Field of View (FOV)**: (`fov`). A global setting for the default lens width (e.g., 50mm).
[DONE]
- **Mouse Wheel Behavior**: (`wheelMode`). Setting whether the wheel should Dolly (move) the camera or Zoom (field of view) by default.
[DONE]
- **Clipping Planes**: (`near` / `far`). Adjustable bounds for the viewing frustum to prevent z-fighting or clipping in massive/tiny scenes.

[DONE]
### Scene Helpers & Gizmos
[DONE]
- **Helper Visibility**: (`showGrid`, `showAxes`). Decide if the ground grid and origin axes should be visible by default on page load.
[DONE]
- **Gizmo Scale**: A preference to adjust the size of the 3D transform handles (Move/Rotate/Scale) to suit the user's screen resolution.
[DONE]
- **Snapping Increments**: (`snapTranslationStep`, `snapRotationDegrees`). Global defaults for object snapping behaviors including on/off and the increment values in degrees.

[DONE]
### Performance & Quality
[DONE]
- **High-Resolution Scaling Cap**: (`_viewportPixelRatio`). A setting to limit the render resolution on high-resolution displays (like 4K) to maintain a high frame rate during interaction. On and Off, on should reduce the render resolution to 1080p, off should allow the render resolution to be decided by the monitor's resolution when the viewport is open like normal.

[DONE]
## Category 6: Logs Tab Settings

[DONE]
### Log Retention & Performance
The log engine tracks every major action (Save, Render, Library Sync). These settings help manage memory and UI performance.
[DONE]
- **Max Lines Per Card**: (`recentLimit`). Dictates how many recent log lines are visible in the UI for an active process before they are truncated (standard is 18).
[DONE]
- **Process History Limit**: (`historyLimit`). A master setting for how many total lines are kept "in memory" for each process (for the 'Download TXT' function) before the oldest lines are purged.
[DONE]
- **Auto-Clear Successful Tasks**: A timer-based setting (e.g., Off, 1 min, 5 min) to automatically remove "Done" process cards from the UI to prevent clutter.
[DONE]
- **Maximum UI Cards**: A limit on how many total process cards can exist in the Logs tab at once. When the limit is hit, the oldest non-active card is removed.

[DONE]
### Visuals & Alerts
[DONE]
- **Completion Flash Effects**: A toggle to enable/disable the "Bloom" and "Tint" visual flashes that occur when a background task (like a 3D render or a library purge) completes.
[DONE]
- **Log Level Filter**: A global filter to decide if the log tab should show all messages (**Info**) or only focus on **Warnings** and **Errors**, it is important that if "all" is turned back on, that the boxes update to show all of the messages that were previously hidden.
[DONE]
- **Message Compaction**: A toggle to enable/disable the collapsing of identical consecutive log messages (e.g., grouping 10 identical "Processing..." messages into a single line with a "x10" badge).
