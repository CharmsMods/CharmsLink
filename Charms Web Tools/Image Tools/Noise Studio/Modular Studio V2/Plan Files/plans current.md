# Studio



saving the camera view doesn't work in the electron bundle



text like "Render Aborted" doesn't go away after a set period of time



the current loading screen for the library loading on page load is pretty vague in what it says the site is actually doing, add more detail and make it more accurate to what is actually going on.



library sorting/tag expanding panel should expand over top of the UI, not push it out



review library saving pipeline and logic, due to saving the library, or the library and the assets tabs into a json file, fails and the console message that might be linked is "Uncaught (in promise) InternalError: allocation size overflow
    downloadJsonFile http://127.0.0.1:5500/src/ui/libraryPanel.js:525
    saveLibraryWorkflow http://127.0.0.1:5500/src/ui/libraryPanel.js:2828
2 libraryPanel.js:525:33
"



options for the entire site should now be moved to right click where it makes sense for "context menus" allowing parts of the UI to be de-bloated, due to not needing to hide literally every setting and UI option behind a dropdown, tab, or button.




for the logs tab, repetitive logs that are the same exact thing, just in sequence one after another, should be combined into a single one with a time stamp range instead of multple of the same thing, this should not effect the txt download, just the way the site presents the logs, if a log is shown, then a diferent log is shown, and then the original log happens again, then nothing needs to be compacted. does this make sense?




full check the entire site to see what cnds or anything that relys on the internet, and if possible, download everything locally and update the code to use the local copy







for the logs tab, when something that was processing finishes sucsessfully, if the logs tab is open, wash the entire background of the page in green to help signify that something good happened for the user, and highlight the box it happened in with a light gold color and a nice animation that will fade away.





make the tab bar, a native loading bar for processes



when something finishes and the Logs tab button turns green or something fails/error and it turns Red, display the message that it came from, to the right of the logs button if the user is not on the logs tab.



use web workers for multi threading cpu, ensure site can confidently identify the correct number of cores for working with for the user's CPU.







add fog or some type of volumetric addition where emissive objects can have halos and (reference picture)





add a loading sequence where the page is unusable when it first loads, where this gives the entire site time to load the important things, and makes it much more likely that the UI will be 100% responsive, some sort of logo animation needed for after i iterate on a design. add a screen that loads before anything on the site, that asks what the user wants to do, and lets them check whether or not they want to load certain tabs of the site on page load, by check boxes, and if the user visits a tab they did not check to have loaded on page load, there should be an overlay asking if they want to boot up that tab. Library however should not be apart of this, and should load every time, and use web workers to let it work in the background doing its loading and searching and healing of any assets along with everything else it does.



















# Bundler Site



ADD NEW TAB to site bundler site, called DIFF that can take 2 uploaded files and analyze their differences line by line and give a report

