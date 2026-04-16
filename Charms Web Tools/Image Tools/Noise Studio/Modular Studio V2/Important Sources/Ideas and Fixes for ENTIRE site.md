# Studio

## Done

[done] saving the camera view doesn't work in the electron bundle

[done] fix rotation and grid snapping on the 3D tab's viewport so it actually works and is toggleable

[done] explore whether or not it's possible to still use right click context menus in electron bundling, since they no longer seem to work anymore.

[done] investigate images not actually saving locally to the user's computer when they name the file in the popup file explorer window and click save when a render finishes, also check why renders dont ALSO automatically save in the assets tab of the library this is the same case for editor json files saving to both the library and locally specifically on electron

[done] between the site's universial header bar that switches tabs, and each site's settings/action bar, when something happens that is important on the site, a 3rd bar in between them will popup, this needs to be removed and have whatever text was there, put on the universial header bar to the right of the logging tab button

[done] fix a library loading bug on electron (not yet tested on web browser) where attempting to load a library file will go through the rendering process, complete, and then the new library files will just not show up and the logs wont have anything useful to say about it.

[done] text like "Render Aborted" doesn't go away after a set period of time on the 3D tab on the viewport

[done] investigate why when the user loads a 3D scene, the objects in it aren't scanned and sucsessfully loaded as assets in the library assets tab.

[done] when a render finishes, add logging for how long it took

[done] the current loading screen for the library loading on page load is pretty vague in what it says the site is actually doing, add more detail and make it more accurate to what is actually going on.

[done] library sorting/tag expanding panel should expand over top of the UI, not push it out

[done] review library saving pipeline and logic, saving the library, or the library and the assets tabs into a json file, fails and the console message that might be linked is "Uncaught (in promise) InternalError: allocation size overflow
    downloadJsonFile http://127.0.0.1:5500/src/ui/libraryPanel.js:525
    saveLibraryWorkflow http://127.0.0.1:5500/src/ui/libraryPanel.js:2828
2 libraryPanel.js:525:33
"

[done] for the logs tab, repetitive logs that are the same exact thing, just in sequence one after another, should be combined into a single one with a time stamp range instead of multple of the same thing, this should not effect the txt download, just the way the site presents the logs, if a log is shown, then a diferent log is shown, and then the original log happens again, then nothing needs to be compacted. does this make sense?

[done] saving a scene to the library from the 3D tab just doesnt work for some reason, more descriptivly, nothing happens when the button is pressd from a visual view, and the logs tab says nothing, there is also no option to download the json for the scene as it is currently, locally

[done] when something finishes and the Logs tab button turns green or something fails/error and it turns Red, display the message that it came from, to the right of the logs button if the user is not on the logs tab.

[done] for the logs tab, when something that was processing finishes sucsessfully, if the logs tab is open, wash the entire background of the page in green to help signify that something good happened for the user, and highlight the box it happened in with a light gold color and a nice animation that will fade away.

[done] FIX light mode across the site's tabs, light mode has a bad effect on text boxes where the text and the background of the box, are both white, making it impossible to read in light mode, making the user only use dark mode all the time.

[done] fix 3D tab's assets drawer: when the user trys to drag and drop something from it into the scene, nothing happens or gets loaded, and the logs tab says nothing

[done] fix the 3 place holder sliders A B and C on the noise layer for the editor tab.

[done] add a crop/rotate/flip layer to the editor tab

[done] for the editor tab, the 3 wheel color grading layer, when the mouse clicks on a wheel, divide the movement of the orignal mouse's movement distance, in order to give the user greater precision when moving inside the wheel, since currently the sensitivity is way too high and the wheels are small so that makes it worse, possibly stacking wheels would allow them to be bigger.

[done] look into a solution for making the UI stay responsive during the 3D viewport rendering in path trace mode (not png renders, just with the viewport open and on path trace mode) 

[done] while the library is loading, show the library's logs from the log tab, on the loading overlay since many new users may not understand that they can see this info on the logs tab.

[done] do a quick check to make sure the library will always load when the page loads even if the user doesnt load on the library page, and while they are on other pages.

[done] add UI option to render the current 3D viewport as a png with whatever samples exist currently

[done] give all the sliders on the 3D tab a value, instead of just being valueless sliders, and allow the user to custom set these values in boxes

[done] ensure site can confidently identify the correct number of cores for working with for the user's CPU. and that it will show up in logging


## Not Done


explore adding ray tracing as an option for viewport and rendering on the 3D tab since it's different than path tracing that we already have


full check the entire site to see what cnds or anything that relys on the internet, and if possible, download everything locally and update the code to use the local copy (very small current priority do not focus on for a while)

in the library, every 3D scene project should be automatically given the tag "3D", every Stitch scene project should be automatically given the tag "Stitch" and every Editor page project in the library should be automatically given the tag "Editor". the library on load already is able to determine the difference between a 3D and a Editor project, so ensure that on site load, the library will scan all projects to make sure they have the correct tag, and give tags to any that dont. so this will just need to be added to the list of things that the library does on load, and ensure that it has it's place in the logs that are sent to the logging tab. this might already be implimented idk.

add fog or some type of volumetric addition where emissive objects can have halos and (reference picture) (for a later implimentation, not until after many other bug fixes)

check to see if the current way the library indexs it's contents on load and during use is making it slower in any way or not using the web workers to full potential, especially on page load for the first time to ensure the page doenst crash.


potentially huge job in terms of making sure nothing is missed, but reorganizing any code files in the database to be in better groups, since there are many different files for different tabs, engines, and having things organized would be a life saver. it would be  extremely important to use move and copy commands,and then edit realtive paths and where files point to, rather than re-writing entire files from scratch and making errors UNLESS things can be improved logically to consolidate things or have them organized better, than this is just fine. Note, this has already been done once with a file that used to exist at over 11k lines called main.js

add animations to the entire site, and a toggle in settings to disable animations for the site

add the option to include the currrent entire settings state in the library json file when exporting a copy of the library out. this would need the added logic for loading it with the library as well.

explore to see whether a translucent frosted glass effective material can be made for the 3D tab for materials is possible with the current glass settings, or if updates would need to be made to add that capability and ensure it works like it should with the path tracing

whole site background UI background image behind everything, with some UI elements being slightly see-through for the picture, not a darkening see through type, but a frosted glass look


library loading and switching between tabs optimization, it's decently slow when a lot of things are loaded or there are a lot of things in the library.


add a tiling layer to the editor tab



add the ability to warp text on the editor tab, and blend it with whatever is behind it


do some digging on the biggest code files currently in the site, to see if any of them are worth breaking down into smaller files for better organization and managment and potentially even performance



png export for editor tab does not always work especially after lots of crashes


the text for some of the fonts in the composite tab is clipped off by the dragging box for it



export to png does not work for the editor or composite tabs


the analog layer of the editor tab, is animated like a video and it should just be a normal layer like the rest.


up and down increment buttons on slider values dont update the canvas for pretty much anything on the editor or maybe even the composite site as well, so the user can only use the sliders or type numbers in instead of also being able to increment by 1 in either direction as well, or whatever 0.1, or value distance that is defined.


