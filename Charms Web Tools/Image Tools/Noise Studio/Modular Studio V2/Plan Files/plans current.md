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


## Not Done

fix 3D tab's assets drawer: when the user trys to drag and drop something from it into the scene, nothing happens or gets loaded, and the logs tab says nothing

for the editor tab, the 3 wheel color grading layer, when the mouse clicks on a wheel, divide the movement of the orignal mouse's movement distance, in order to give the user greater precision when moving inside the wheel, since currently the sensitivity is way too high and the wheels are small so that makes it worse, possibly stacking wheels would allow them to be bigger.

look into a solution for making the UI stay responsive during the 3D viewport rendering in path trace mode (not png renders, just with the viewport open and on path trace mode) 

while the library is loading, show the library's logs from the log tab, on the loading overlay since many new users may not understand that they can see this info on the logs tab.

do a quick check to make sure the library will always load when the page loads even if the user doesnt load on the library page, and while they are on other pages.

explore adding ray tracing as an option for rendering since it's different than path tracing that we already have

add an option for rendering to do a render in the selected modes from the same camera setting automatically

add UI option to render the current viewport as a png

give all the sliders on the 3D tab a value, instead of just being valueless sliders, and allow the user to custom set these values in boxes

options for the entire site should now be moved to right click where it makes sense for "context menus" allowing parts of the UI to be de-bloated, due to not needing to hide literally every setting and UI option behind a dropdown, tab, or button. (this idea must first rely on a verdict from figuring out if this still works on electron, and how to make it more reliable on browser, before switching to it more heaviliy)

full check the entire site to see what cnds or anything that relys on the internet, and if possible, download everything locally and update the code to use the local copy (very small current priority do not focus on for a while)

inspect worker for handling the background png render of the 3D tab, and inspect how the worker handles the gpu while making sure the rest of the site is still usable and switching tabs still works perfectly, since currently starting a render, and leaving the 3D tab works fine, but then trying to come back to it the page freezes a lot and sometimes crashes

idea to make the universial tab bar, a native loading bar for processes

ensure site can confidently identify the correct number of cores for working with for the user's CPU. and that it will show up in logging

move the dark/light mode toggle from the editor tab, to a new settings tab that will exist in the universial site tab just to the left of the logs tab:
settings tab:
a central place for setting the site's settings for use.
settings can include but are not limited to (i will need to think of more)
button to scan for and fix library files that may not have a final rendered version in their json.

add fog or some type of volumetric addition where emissive objects can have halos and (reference picture) (for a later implimentation, not until after many other bug fixes)

check to see if the current way the library indexs it's contents is making it slower in any way or not using teh web workers to full potential, especially on page load for the first time.

perhaps adding a loading sequence where the page is unusable when it first loads, where this gives the entire site time to load the important things, and makes it much more likely that the UI will be 100% responsive, some sort of logo animation needed for after i iterate on a design. or add a screen that loads before anything on the site, that asks what the user wants to do, and lets them check whether or not they want to load certain tabs of the site on page load, by check boxes or toggles, and if the user visits a tab they did not check to have loaded on page load, there should be an overlay asking if they want to boot up that tab. Library however should not be apart of this, and should load every time and background process it's startup processes; use web workers to let it work in the background doing its loading and searching and healing of any assets along with everything else it does in the background, which is quite a lot on load and the first few interactions.

potentially huge job in terms of making sure nothing is missed, but reorganizing any code files in the database to be in better groups, since there are many different files for different tabs, engines, and having things organized would be a life saver. it would be  extremely important to use move and copy commands,and then edit realtive paths and where files point to, rather than re-writing entire files from scratch and making errors.

add animations to the entire site, and a toggle in settings to disable animations for the site
