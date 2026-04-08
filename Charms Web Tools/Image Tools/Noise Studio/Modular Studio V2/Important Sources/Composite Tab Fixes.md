when importing multiple editor projects as canvas objects, the handles they get assigned dont always conform to the actual image shape, and then ruin the render because the image then conforms to the handles instead of the other way around, meaning the user could set the image where they want it, but the handles for it might be super small and not around the edges of the image, and then on png render, the image is stretched to fit the handles that are in the wrong spot.

cant seem to scale images down using the handles past a certian limit, this also goes along with the canvas zoom limit, i want the engine to stop thinking in absolute scaling for the zoom and images, and instead just let the user zoom in and out as much as they want, it doesnt matter if they zoom far in and build their project there, because they can set the resolution of the export, since the canvas that we are laying stuff out on shouldnt have a resolution, its just a 2D surface for us to work on.

in addition to the auto resolution matching of the render tab for the area selection, we need to also be able to auto 


sliders do update in real time with things which is great when im draggin things, however i cant click and drag sliders, they only respond to clicks along their line where the slider dot is. the same sort of bug applies to the text boxes for entering values, where i click in the box, the either type one thing, or delete something, and the box is immediately unfocused. this goes for the content of the text box objects as well

the logic for the export should be updated to understand, it's likely that whatever the user wants to render/export, is going to be on their screen visible on the canvas when they click on the render tab, so make sure that the area for the render area isnt super big because it thinks it needs to cover this perhaps huge background object that's just being used for color, and is way bigger than the currently observable canvas.


when saving a composite project to the library, it looks like it doenst include a thumnail for the project


after saving to library, autosave for open and changed composite projects fires wayy too often with "Autosaved "composite 1" to the Library." in the logs piling up, after every change, which makes the UI stutter for a few frames, which is annoying so the save time should be increased to 10 seconds, and not happen after every movment. also just run a quick check to make sure it's not saving a new copy every time it saves, (it doesnt look like it does but always good to make sure as this would definately blow up the library)

we also need the ablity to add more than just squares to the canvas, include circles, triangles.


the stretch scale mode for allowing a user to stretch or squish a canvas object in a direction, doesnt show up anywhere that i can see


holding down middle click and dragging on the canvas should pan the user around even tho they may not be *not hovering over something*, and the right click while not hovering over something should be remapped to clicking and dragging to select objects


the user should be able to delete 1 or more selected objects by pressing delete


when multiple objects are selected, a math mathmatical rectangle should be invisibly constructed perfectly around all selected objects, just encasing them, and then new handles along that rectangle should appear, allowing the user to transform all selected objects at once, with the same transform modes as normal, and the same transform options in the side bar, with the engine treating them like one big object, then once they are deselected, they go back to being treated like normal indevidual objects again.


the composite tab needs its own settings catagory and settings to go along with it.


any regular uploaded images; the user should be able to convert those into an editor project and edit them for the canvas just like other editor projects, as updates to that image converted into an editor project are made, whenever the composite project saves to the library, it will of course save all assets and projects needed to reconstruct it, but also that new editor project that was made from an uploaded image on to the compositor canvas, then edited in the editor tab; it should be saved as a new seperate editor project in normal format like the rest and updated at the same time as the composite project saves to the library.